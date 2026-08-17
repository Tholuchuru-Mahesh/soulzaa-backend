# Agency Member Profile — Backend-Driven Data

**Date:** 2026-08-17
**Repos:** `soulzaa-backend`, `soulzaa-mobile`
**Status:** Approved design, ready for implementation planning

## Problem

`MemberProfileScreen` in the mobile app (Community Management → Member List →
Member Profile) is 1398 lines, and most of what it displays is hard-coded from
the Figma rather than fetched. The email reads `ananya@gmail.com` for every
member. The full name reads `Ananya sharma`. Rank is `#7 of 7,541`, engagement
is `72/100`, the four Details Metrics bars are PNG exports, and the six
activity-timeline cards are literals in the widget tree.

The backend already returns more than the screen consumes. `getMember` in
`agency-member.service.ts` returns `avatarUrl`, `joinedAgencyAt`, `username`
and a real merged `timeline`, and the screen discards all four in favour of
bundled assets.

The goal: every value on all three tabs comes from the API, and nothing on
screen states a figure the platform cannot substantiate.

## Decisions

Five questions were settled before design:

1. **Engagement score** is a weighted activity mix over a rolling 30-day
   window, normalised to 0–100.
2. **Rank in agency** is by that same engagement score, so rank, score, grade
   and the "Top X% Active" badge are all one rule.
3. **API shape** is split by tab, with paged sub-resources for timeline,
   rewards and events, so `Load more` and `View all` become real.
4. **The three inert controls** (date range, sort order, chart range) all
   become functional.
5. **Timeline animation** is a staggered fade-and-slide entrance.

## Field audit

Everything the screen shows, and where it will come from.

### Already available, currently ignored

| Screen | Source |
|---|---|
| Profile image | `avatarUrl` — already in the payload |
| Joined on | `AgencyRelationship.effectiveFrom` — already in the payload |
| Username | `User.username` — already in the payload |
| Activity timeline | already returned as `activity.timeline` |

### Available in the database, not yet queried

| Screen | Source |
|---|---|
| Email | `User.email` |
| Full name | `User.fullName` |
| Gender | `User.gender` |
| Language | `User.preferredLanguage` |
| Login days | distinct `DATE(SessionHistory.createdAt)` where `event = CREATED` |
| Rewards received | `AgencyRewardDistribution` by `recipientId` + `agencyId` |
| Events joined | `EventParticipant` joined to `EventDefinition` |
| Agency star / badges | `BadgeInventory` + `BadgeDefinition` |
| Audio room joins | `RoomMember.joinedAt` |
| Video room joins | `VideoRoomMember.joinedAt` |

### Derived — defined by this spec

Engagement score, performance grade, rank in agency, percentile
("Top X% Active"), the `vs last month` trend on every stat card, the four
Details Metrics percentages, and the engagement chart series. None of these
exist as columns; all are computed from the tables above.

## Backend design

### Scoring engine — `AgencyMemberScoreService`

One new service, one primary method:

```ts
rankAgency(agencyId: string): Promise<Map<string, MemberScore>>
```

It scores **every** active member of the agency in one pass and returns them
ranked, because a single member's rank cannot be known without scoring the
others.

#### Inputs

All measured over `SCORE_WINDOW_DAYS` (30), ending now.

| Input | Query |
|---|---|
| `loginDays` | distinct calendar days with a `SessionHistory` row, `event = CREATED` |
| `roomsJoined` | `RoomMember` + `VideoRoomMember` rows with `joinedAt` in window |
| `giftsSent` | `GiftTransaction` count by `senderId` |
| `giftsReceived` | `GiftTransaction` count by `receiverId` |

#### Formula

```ts
export const SCORE_WEIGHTS = {
  loginDays:     { weight: 0.30, cap: 30 },
  roomsJoined:   { weight: 0.25, cap: 30 },
  giftsSent:     { weight: 0.25, cap: 50 },
  giftsReceived: { weight: 0.20, cap: 50 },
} as const;

score = Math.round(
  100 * Σ ( weight * Math.min(value / cap, 1) )
);
```

Weights sum to 1.00, so the score is bounded 0–100 by construction. Every
input is capped before weighting, so one member who sent 10,000 gifts cannot
saturate the whole scale for the agency.

#### Grade bands

```ts
export const GRADE_BANDS = [
  { min: 80, code: 'EXCELLENT',   label: 'Excellent',   caption: 'keep it up!' },
  { min: 60, code: 'GOOD',        label: 'Good',        caption: 'nearly there' },
  { min: 40, code: 'FAIR',        label: 'Fair',        caption: 'room to grow' },
  { min:  0, code: 'NEEDS_WORK',  label: 'Needs work',  caption: 'let us help' },
] as const;
```

`SCORE_WEIGHTS` and `GRADE_BANDS` live in
`src/modules/agencies/constants/member-score.constants.ts` so the model can be
retuned without touching query code.

#### Worked example

The member used in every sample payload below, so the numbers in this document
are mutually consistent and can be used directly as a test fixture:

| Input | Value | Capped ratio | × weight |
|---|---|---|---|
| `loginDays` | 12 | 12/30 = 0.400 | 0.120 |
| `roomsJoined` | 18 | 18/30 = 0.600 | 0.150 |
| `giftsSent` | 50 | 50/50 = 1.000 | 0.250 |
| `giftsReceived` | 50 | 50/50 = 1.000 | 0.200 |
| | | **Σ = 0.720** | **score 72** |

Score 72 falls in the `GOOD` band (60–79).

The same member's distinct-day counts, used by the Details Metrics: 12 login
days, 10 days with an audio-room join, 8 days with a video-room join — giving
40%, 33% and 27% of the 30-day window respectively.

#### Rank and percentile

Members sort by score descending. Ties break by `userId` ascending, so the
ordering is stable across requests and two members with identical scores never
swap positions between two page loads.

```
rank        = index + 1
totalMembers= size of the ranked set
topPercent  = Math.max(1, Math.ceil((rank / totalMembers) * 100))
```

`topPercent` is only meaningful in a reasonably sized group. When
`totalMembers < 10` it is returned as `null`, and the client omits the
"Top X% Active" sub-label rather than telling a 3-member agency that someone
is in the top 34%.

#### Cost and caching

Naively this is four queries per member — over 30,000 queries for a
7,541-member agency. Instead it is **four `groupBy` queries over the entire
member set**, bucketed in memory. This is the same approach
`AgencyCommunityService.getGrowth` already uses to avoid one `COUNT` per day.

The ranked map is cached in Redis at `agency:member-rank:{agencyId}` with a
300-second TTL. Both the Overview and Performance tabs read through the cache,
so opening ten member profiles in sequence computes the ranking once. There is
no explicit invalidation — a five-minute-stale engagement score is acceptable,
and TTL expiry is simpler than tracking every event that could move a rank.

### Service split

`agency-member.service.ts` is 258 lines today. Adding the activity, history,
performance and scoring work to it would take it past 900 lines and make it
the kind of file where every edit risks something unrelated. Five services:

| Service | Responsibility | Depends on |
|---|---|---|
| `AgencyMemberService` *(exists)* | member list, Overview payload | Score, Prisma, Profile |
| `AgencyMemberScoreService` *(new)* | score, grade, rank, percentile | Prisma, Redis |
| `AgencyMemberActivityService` *(new)* | activity counters, paged timeline | Prisma |
| `AgencyMemberPerformanceService` *(new)* | Performance payload, chart, metrics | Prisma, Score |
| `AgencyMemberHistoryService` *(new)* | paged rewards and events | Prisma |

Membership verification — that the requested `userId` has an `ACTIVE`
`AgencyRelationship` with the calling agency — is extracted into a single
`assertMember(agencyId, userId)` helper on `AgencyMemberService` and called by
all four new endpoints. It stays one implementation so a future endpoint
cannot forget it.

### Endpoints

All on the existing `AgencyMemberController`, keeping
`@UseGuards(JwtAuthGuard, RbacRolesGuard)` and `@RequireRoles('AGENCY')`. The
agency is always taken from the JWT; no endpoint accepts an `agencyId`.

```
GET /agencies/me/members/:userId
GET /agencies/me/members/:userId/performance?range=week|month|quarter
GET /agencies/me/members/:userId/activity?page&limit&from&to&sort
GET /agencies/me/members/:userId/rewards?page&limit
GET /agencies/me/members/:userId/events?page&limit
```

#### Coin values

Coin figures are `BigInt` in Postgres and are always serialised as strings,
per the existing convention. Where a coin figure needs a trend, it uses a
string-valued variant of `MetricDelta`:

```ts
export interface CoinMetricDelta {
  value: string;
  changePercent: number | null;
  comparedTo: 'LAST_MONTH';
}
```

#### `GET /:userId` — Overview

```jsonc
{
  "profile": {
    "userId": "…", "username": "ananya_21", "displayName": "Ananya",
    "fullName": "Ananya Sharma", "avatarUrl": "https://…",
    "email": "ananya@example.com", "gender": "FEMALE", "language": "English",
    "country": "India", "joinedAgencyAt": "2026-05-10T…",
    "registeredAt": "2026-04-02T…", "isActive": true,
    "coins": "12400", "earnings": "3200"
  },
  "badge": {
    "code": "AGENCY_STAR", "name": "Agency star", "iconUrl": "https://…",
    "tier": "GOLD", "topPercent": 1, "totalBadges": 7
  },
  "stats": {
    "giftsSent":     { "value": 50,      "changePercent": 10.1, "comparedTo": "LAST_MONTH" },
    "coinsSent":     { "value": "45200", "changePercent": -3.4, "comparedTo": "LAST_MONTH" },
    "giftsReceived": { "value": 50,      "changePercent": null, "comparedTo": "LAST_MONTH" },
    "coinsReceived": { "value": "31000", "changePercent": 8.2,  "comparedTo": "LAST_MONTH" },
    "roomsJoined":   { "value": 18,      "changePercent": 22.0, "comparedTo": "LAST_MONTH" }
  },
  "summary": {
    "rank": 7, "totalMembers": 7541,
    "engagementScore": 72,
    "grade": { "code": "GOOD", "label": "Good", "caption": "nearly there" }
  }
}
```

`badge` is `null` when the member has no equipped badge — the client hides the
Agency star panel rather than showing an empty frame.

#### `GET /:userId/performance`

`range` defaults to `month`.

```jsonc
{
  "rank": { "position": 7, "totalMembers": 7541, "topPercent": 1 },
  "grade": { "code": "GOOD", "label": "Good", "caption": "nearly there" },
  "engagement": { "score": 72, "outOf": 100, "topPercent": 1 },
  "chart": {
    "range": "month",
    "points": [ { "date": "2026-07-19", "value": 61 }, … ]
  },
  "metrics": [
    { "key": "ENGAGEMENT_RATE",   "label": "Engagement rate",          "percent": 72, "changePercent": 10.1 },
    { "key": "VIDEO_ROOM",        "label": "Video room participation", "percent": 27, "changePercent": 1.8  },
    { "key": "AUDIO_ROOM",        "label": "Audio room participation", "percent": 33, "changePercent": 14.6 },
    { "key": "DAYS_ACTIVE",       "label": "Days active",              "percent": 40, "changePercent": 50.9 }
  ]
}
```

**`topPercent` appears three times** — on `badge`, on `rank` and on
`engagement` — and is always the same number from the same computation. It is
repeated so each card can render independently without the client having to
cross-reference another part of the payload.

**The congratulatory message.** The screen's `Great job, Ananya! 🌟 / You are
among the top 10% most active members in your agency.` is composed on the
client from `displayName` and `topPercent`, not sent as a server string. User-
facing prose belongs in the app so it can be localised, and a server that ships
English sentences would have to be redeployed to reword them. When `topPercent`
is `null` (agency under 10 members) the client falls back to a message keyed on
the grade band instead, so the banner is never blank.

**Metric definitions.** Each is a percentage of the 30-day window, so all four
are on one comparable scale:

- `ENGAGEMENT_RATE` — the engagement score itself
- `VIDEO_ROOM` — distinct days with a `VideoRoomMember` join ÷ 30
- `AUDIO_ROOM` — distinct days with a `RoomMember` join ÷ 30
- `DAYS_ACTIVE` — distinct login days ÷ 30

`changePercent` on each compares the window against the preceding 30 days, and
is `null` when that baseline was zero.

**Chart series.** One point per day across the range (7 / 30 / 90 days). Each
point is a **7-day rolling engagement score** ending on that day: the same
weights and the same formula, with every cap scaled by `7/30` (so `loginDays`
caps at 7, `roomsJoined` at 7, `giftsSent` and `giftsReceived` at ~11.67). This
keeps a 7-day window on the same 0–100 scale as the 30-day headline score, so
the chart and the score card are directly comparable.

Rolling rather than per-day because a single-day score is mostly noise — a
member who logs in six days out of seven would otherwise plot as a sawtooth
between 0 and 100.

The first six points of any range need the six days *before* the range to fill
their window, so the query fetches `rangeDays + 6` days of raw events. All of
them are fetched once and bucketed in memory; the series is never one query
per day.

The client's `EngagementOverviewChart` already fixes its axis at 0–100 and
handles an empty series, so it needs no change beyond its input.

#### `GET /:userId/activity`

Counters and timeline share the `from`/`to` filter, so they are returned
together — changing the date range is one request, not two.

```jsonc
{
  "range": { "from": "2026-07-18T…", "to": "2026-08-17T…" },
  "counters": {
    "totalActivities": 135, "loginDays": 12, "giftsSent": 50,
    "giftsReceived": 50, "roomsJoined": 18, "eventsJoined": 5
  },
  "timeline": {
    "items": [
      { "id": "…", "kind": "LOGIN", "title": "Login",
        "detail": "user logged in to the application",
        "occurredAt": "2026-08-17T11:45:00Z" }
    ],
    "page": 1, "limit": 20, "total": 135, "totalPages": 7
  }
}
```

`kind` expands from today's two values to six, matching what the design shows:
`LOGIN`, `GIFT_SENT`, `GIFT_RECEIVED`, `ROOM_JOINED`, `VIDEO_ROOM_JOINED`,
`EVENT_JOINED`. The client maps `kind` to icon and accent colour; the server
sends no colours or asset paths.

`sort` accepts `newest` (default) or `oldest`. `from`/`to` default to the last
30 days. Merging six sources under a sort and a page window means each source
is queried with the same order and window, merged, sorted, then sliced — the
existing `buildTimeline` already does this for two sources and generalises.

`totalActivities` is the sum of the other five counters, which is what the
current implementation means by the term.

#### `GET /:userId/rewards`

```jsonc
{
  "items": [
    { "id": "…", "name": "Premium medal", "itemType": "MEDAL",
      "kind": "ASSIGNED", "note": "For top performance",
      "quantity": 1, "receivedAt": "2026-06-20T…" }
  ],
  "page": 1, "limit": 20, "total": 12, "totalPages": 1
}
```

Scoped to `recipientId = :userId AND agencyId = <caller>`, so an agency sees
only the rewards it sent — not rewards the member received from another agency.

#### `GET /:userId/events`

```jsonc
{
  "items": [
    { "eventId": "…", "name": "Quiz challenge", "thumbnailUrl": "https://…",
      "startTime": "2026-05-21T18:10:00Z", "status": "COMPLETED",
      "completedAt": "2026-05-21T19:30:00Z" }
  ],
  "page": 1, "limit": 20, "total": 5, "totalPages": 1
}
```

`status` is `EventParticipant.status`, with `COMPLETED` derived from a non-null
`completedAt`. The client renders the chip from `status`, so a participating-
but-unfinished event does not display as "Completed".

### Null, never zero

The convention documented in `agency-dashboard.interface.ts` is extended to
every field here: a value the platform genuinely cannot answer is `null`, and
the client renders it as an em dash.

- A member with no `gender` set returns `null`, not `"Female"`
- A member with no equipped badge returns `badge: null`, not a placeholder
- `changePercent` is `null` when the baseline window was zero
- `topPercent` is `null` when the agency has fewer than 10 members

A **zero** is only ever returned when zero is the true answer — a member who
genuinely sent no gifts has `giftsSent: 0`, and an engagement score of `0` for
a completely inactive member is a real measurement, not a missing one.

## Mobile design

### Screen decomposition

The 1398-line screen becomes roughly 150 lines — app bar, tab selector, tab
dispatch. Each card moves to its own widget file under
`lib/features/profile/presentation/widgets/member_profile/`:

```
member_profile_header_card.dart       avatar, id, country, joined, email, active
member_basic_information_card.dart    name/username/gender/language + Agency star
member_performance_summary_card.dart  rank, engagement score, grade
member_rewards_card.dart              rewards received
member_events_card.dart               events joined
member_activity_tab.dart              date filter + counters
member_activity_timeline.dart         animated timeline + _DottedLinePainter
member_performance_tab.dart           rank/grade cards, score banner, chart
member_detail_metrics_card.dart       the four metric rows
metric_bar.dart                       drawn progress bar
```

`_DottedLinePainter` moves with the timeline. `metric_bar.dart` replaces the
`Line 60.png` … `Line 66.png` bitmap exports: a fixed-width PNG cannot
represent a variable percentage, and it stretches on any phone that is not the
artboard width.

`EngagementOverviewChart` is not modified.

### Models

Hand-written `fromJson`, matching the existing style in
`agency_member_models.dart`. **Not** `@freezed` — `build_runner` cannot run in
this repo, so a codegen model would never compile.

- `agency_member_models.dart` — extended `AgencyMemberDetail` with the new
  profile fields, `badge`, `stats` and `summary`
- `agency_member_performance_models.dart` — new
- `agency_member_history_models.dart` — new: rewards, events, activity page

Coin fields parse from strings, never cast from numbers, per the existing
`_coins` helper.

### Providers

Following the family-by-`userId` pattern already established — this is what
prevents a second member's profile showing the first member's figures.

```dart
agencyMemberDetailProvider(userId)       // exists, extended
agencyMemberPerformanceProvider(args)    // new, family over (userId, range)
agencyMemberRewardsProvider(userId)      // new
agencyMemberEventsProvider(userId)       // new
agencyMemberActivityControllerProvider   // new Notifier, family over userId
```

The activity controller is a `Notifier` rather than a `FutureProvider` because
it accumulates pages across `Load more` and owns the date-range and sort state.
The other three are read-only and stay `FutureProvider.family`, auto-disposed.

`AgencyMemberRemoteDataSource` and `AgencyMemberRepository` each gain four
methods mirroring the four new endpoints.

### Per-tab loading

Each tab watches its own provider and uses `.when(loading/error/data)` with the
same treatment as `member_list_screen.dart` — a pink
`CircularProgressIndicator` while loading, error text with a retry action.

Because Performance is its own request, opening a profile no longer waits on
the agency-wide rank computation; that fires only when the tab is tapped.

### Timeline animation

Each timeline card wraps in a `TweenAnimationBuilder<double>`:

- opacity `0 → 1`
- translate `y: +12px → 0`
- duration 300ms, `Curves.easeOut`
- stagger `60ms * index`

The animation re-keys on the current filter, so changing the date range or
sort order visibly redraws the list. Stagger is capped at the first 12 items,
so appending page 3 via `Load more` does not produce a 1.5-second cascade.

### The three controls

| Control | Behaviour |
|---|---|
| Date chip `13 May 2026 - 15 May 2026` | opens `showDateRangePicker`, defaults to last 30 days, sends `from`/`to`, refreshes counters and timeline together |
| `Newest first` | dropdown toggling `sort=newest\|oldest` |
| `This month` | dropdown over week / month / quarter, re-keys the performance provider |

The chip label renders the actual selected range, not a fixed string.

### `View all` and `Load more`

- `Load more` on Activity appends the next timeline page, and hides itself when
  `page >= totalPages`
- `View all` on Rewards and Events opens a paged list of the same resource

## Testing

### Backend

New specs beside the existing `agency-member.spec.ts`:

- `agency-member-score.spec.ts` — score at zero activity, at every input
  capped, and at each grade-band boundary (79/80, 59/60, 39/40); weights sum
  to 1.0; rank ordering including a tie; `topPercent` null below 10 members
- `agency-member-activity.spec.ts` — six-source merge respects sort and page
  window; `from`/`to` filtering; counters agree with the timeline total
- `agency-member-history.spec.ts` — rewards scoped to the calling agency;
  event status mapping
- Cross-agency isolation: each of the four new endpoints returns 404 for a
  `userId` belonging to a different agency

### Mobile

`fromJson` tests for each new model against realistic payloads, including a
null-heavy response (no badge, no gender, all `changePercent` null) to confirm
the em-dash path rather than a crash or a fabricated zero.

## Out of scope

- The `Reward user` and `Send message` buttons on the header card. They are
  unwired today and stay unwired; wiring them is a separate feature with its
  own flows.
- A badge detail screen behind `View all Badges`. The count becomes real; the
  navigation target does not exist yet.
- Backfilling historical activity. The score reflects what the platform
  recorded, so agencies whose data predates the relevant tables will see low
  scores until 30 days of data accumulate.

## Risks

**Cold-start scores look bad.** On a platform with sparse `SessionHistory` or
`RoomMember` data, most members will score near zero and grade as "Needs
work". This is an honest reading of the data, but it will look broken. The
tunable constants block exists partly so the caps can be lowered to match real
platform volumes once the distribution is known.

**Ranking cost on very large agencies.** Four `groupBy` queries over 30 days
of gift and room data for a 7,541-member agency is not free. The 5-minute
Redis cache bounds it to once per agency per 5 minutes. If it proves too slow
in production, the next step is a nightly materialised score table rather than
further query tuning.
