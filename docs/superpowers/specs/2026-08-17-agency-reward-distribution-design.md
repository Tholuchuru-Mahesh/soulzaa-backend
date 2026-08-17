# Agency Reward Distribution — Real Data and a Working Send

**Date:** 2026-08-17
**Repos:** `soulzaa-backend`, `soulzaa-mobile`
**Status:** Approved design, ready for implementation planning

## Problem

Six screens make up the agency reward flow. Two are wired; three show invented
data; and the write path does not exist.

| Screen | Lines | State |
|---|---|---|
| Reward Inventory | 661 | Wired to `GET /agencies/me/rewards/inventory` |
| Send Reward (reward picker) | 294 | Wired to the same endpoint |
| Reward Distribution | 479 | 6 hard-coded members, 3 hard-coded stats |
| Send Reward Confirm | 494 | `_recipient = 'Ananya_21'`; never calls the API |
| Distribution History | 414 | 8 hard-coded rows |
| Send Reward Success | 112 | Reached unconditionally |

Two problems sit behind the hard-coded values.

**The send does nothing.** `POST /agencies/me/rewards/distribute` is
implemented, transactional, idempotent and stock-checked. Nothing in the app
calls it. The confirm screen's slide control navigates to the success screen
directly, so a user who slides it sees a success screen for a reward that was
never sent.

**The wizard carries no state.** The distribution screen pushes to Send Reward
without the member (`agency_reward_distribution_screen.dart:285`), and Send
Reward pushes to Confirm without the reward
(`agency_send_reward_screen.dart:271`). Neither the recipient nor the reward
survives a navigation, which is why the confirm screen has to hard-code a name
— there is nothing to receive.

## Decisions

1. **Scope is both** — the three read screens become backend-driven *and* the
   send is made to work end to end.
2. **Member level** comes from `UserStatistics.level`, added to the member list
   payload.
3. **"Top performers"** means `topPercent <= 10` from `AgencyMemberScoreService`
   — the same ranking behind the member profile's "Rank in Agency".

## Backend

### 1. `GET /agencies/me/members` — level and filter

Adds one field and one query parameter:

```
?filter=all|active|top        default: all
items[] gains: level: number  from UserStatistics
```

`level` is a bulk read keyed by `userId`, alongside the wallet read already
there — no per-member query. A member with no `UserStatistics` row returns
`level: 1`, matching the column's own default, rather than `0` or `null`: every
account starts at level 1, so 1 is the true answer for a member nobody has
written statistics for yet.

`filter=active` uses the `isActive` flag already computed. `filter=top` reads
`topPercent <= 10` from `AgencyMemberScoreService.rankAgency(agencyId)`, which
is cached for five minutes.

**In an agency with fewer than 10 members, `topPercent` is null for everyone**
(the scoring service withholds a percentile that small), so `filter=top` would
return nobody. Rather than show an empty list that looks broken, it falls back
to the single highest-ranked member — in a 6-person agency the top performer is
one person, not a tenth of one.

**Filtering happens before pagination.** Filtering the page after slicing it
would make page 2 of a filtered list wrong — it would show the filtered subset
of page 2's members rather than the second page of filtered members.

### 2. `GET /agencies/me/rewards/distributions` — usable history

Today the method takes only `limit` and returns a bare `recipientId`. It gains:

```
?page&limit&range=all|today|week|month     default: all, page 1, limit 20

{
  "items": [{
    "id": "…", "recipientId": "…",
    "recipientName": "balayya", "recipientAvatarUrl": "https://…",
    "itemType": "MEDAL", "name": "Premium medal",
    "quantity": 1, "kind": "ASSIGNED", "note": "For top performance",
    "occurredAt": "2026-06-20T…"
  }],
  "page": 1, "limit": 20, "total": 42, "totalPages": 3
}
```

Recipient identity resolves through `PROFILE_SERVICE`, in one bulk call for the
page — the history rows render a recipient thumbnail, which a bare id cannot
fill. `recipientName` and `recipientAvatarUrl` are null when the profile seam
has nothing, and the row falls back to its existing colour-block placeholder.

`range` maps to a `createdAt` lower bound: `today` = start of today,
`week` = 7 days back, `month` = 30 days back, `all` = no bound.

### 3. `GET /agencies/me/rewards/stats` — new

```jsonc
{ "totalSent": 1248, "today": 24, "thisMonth": 378 }
```

Three counts over `AgencyRewardDistribution`, scoped to the calling agency.

Its own endpoint rather than a block on `distributions`, because the two serve
different screens: the distribution screen wants stats plus a member list and
no rows at all, while the history screen wants rows and no stats. Folding them
together would make each screen fetch data it discards.

### 4. `POST /agencies/me/rewards/distribute` — unchanged

Already correct: it validates quantity, replays idempotently on
`idempotencyKey`, proves the recipient is an active member, locks the shelf row
with `FOR UPDATE` before reading stock, rejects insufficient and expired stock,
and writes the distribution plus the backpack grant in one transaction. This
work only has to call it.

## Mobile

### The wizard needs state

A three-step flow whose steps cannot see each other cannot be fixed by wiring
each screen independently. The selection has to live somewhere both later
screens can read.

`AgencyRewardDraftController` — a `Notifier` holding the send being composed:

```dart
class AgencyRewardDraft {
  final String? recipientId;
  final String? recipientName;
  final String? inventoryId;
  final String? rewardName;
  final String? rewardItemType;
  final int quantity;
  final String kind;          // ASSIGNED | OWNED
  final String? note;
  final String idempotencyKey; // generated once, when the draft starts
}
```

Chosen over GoRouter `extra` because `extra` is lost on a deep link or a
process restore, and because the draft is genuinely shared state rather than a
one-way argument: the confirm screen may send the user back to change the
reward, and that must not lose the recipient.

**The idempotency key is generated once, when the draft is started from the
member card** — not per slide. A key regenerated on each attempt would defeat
the server's replay protection precisely when it matters: a send that timed out
but succeeded, retried by the user.

### Providers

```dart
agencyRewardInventoryProvider          // exists, unchanged
agencyRewardStatsProvider              // new — distribution screen header
agencyDistributionsProvider(range)     // new — family over the four chips
agencyRewardDraftControllerProvider    // new — the wizard's state
```

The member picker reuses `agencyMemberListControllerProvider`, already built
for Community Management, extended with the `filter` parameter.

### Screens

**Reward Distribution** becomes a `ConsumerStatefulWidget`. The three stat
cards read `agencyRewardStatsProvider`; the member list reads the member
controller with the active filter chip; the search box drives the existing
server-side `search` parameter. Tapping a member's send button starts the draft
with that member and pushes to Send Reward.

**Send Reward** already lists real inventory. It gains selection: tapping a
reward records it on the draft, and the continue button is disabled until one
is chosen. Today it pushes to confirm regardless.

**Send Reward Confirm** reads the draft instead of `_recipient = 'Ananya_21'`.
On slide-commit it calls distribute, and then:

```
success -> invalidate inventory, distributions and stats
        -> pushReplacement to the success screen
failure -> stay on the screen, show the server's message, slider springs back
```

`pushReplacement`, not `push`: the confirm screen must not sit behind the
success screen, or Back returns the user to a slider for a reward they have
already sent.

The success screen takes the distribution the server returned —
`{ id, name, quantity, recipientName }` — so it states what was actually sent
rather than re-reading the draft, which would show what was *requested*. Those
differ if the server clamped or replayed.

The slider must be disabled while the request is in flight — a second slide
during the first would issue a second request, and although the server would
replay it idempotently, the UI would race itself.

**Distribution History** becomes a `ConsumerStatefulWidget` reading
`agencyDistributionsProvider(range)`, with the four chips selecting the range
and a Load more that pages.

### Empty states

Every list gets one. "No rewards sent yet." on the history screen, "No members
match this filter." on the distribution screen. The history screen will be
empty on day one — there are no real distributions in the data — and an empty
list that says so is the difference between working and broken.

## Testing

### Backend

- `agency-member.spec.ts`: `filter=top` returns only the top decile; falls back
  to the single best member in an agency under 10; filtering precedes
  pagination; `level` reads from statistics and is 1 when the row is absent
- `agency-reward.spec.ts`: distributions scope to the calling agency; each
  `range` boundary; recipient identity resolves in one bulk call; stats agree
  with the rows they summarise
- Cross-agency isolation on both new/changed endpoints

### Mobile

- `fromJson` for the distribution row and stats models, including null
  recipient identity
- Draft controller: the idempotency key is stable across rebuilds and changes
  only when a new draft starts
- Confirm screen: sending disables the slider; a failure keeps the user on the
  screen; a success navigates exactly once

## Out of scope

- The notifications screen's hard-coded rows (`agency_notifications_screen.dart`)
- Choosing `kind` (`ASSIGNED` / `OWNED`) in the UI — the draft carries it and
  defaults to `ASSIGNED`, matching the server default; exposing the choice is a
  separate design question
- Editing or recalling a sent reward. `AgencyRewardDistribution` is append-only
  by design and there is no server path for it

## Risks

**The history screen will look empty after this lands.** That is the correct
rendering of an empty table, but it will read as "still broken" to anyone who
was looking at eight invented rows the day before. Sending one reward from the
app populates it.

**`filter=top` costs a whole-agency ranking.** Cached for five minutes and
shared with the member profile and leaderboard, so the first agency to open any
of the three pays for all of them. On a very large agency the first request
after cache expiry will be noticeably slower than the other two filters.
