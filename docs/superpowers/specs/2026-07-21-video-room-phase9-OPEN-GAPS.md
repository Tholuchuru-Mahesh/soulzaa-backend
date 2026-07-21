# VR-9 Chat System — Open Gap Register

**Date:** 2026-07-21
**Status of phase:** 23 tasks + 2 follow-ups complete. 1851/1854 tests pass (3 = quarantined
treasure-boxes, unrelated). tsc 0 · build clean · `DI OK` · boundaries unchanged · nothing committed.
**This document lists what is NOT done.**

How this list was produced: a "declared but never wired" sweep across every symbol the phase
introduced (error codes, config fields, socket events, bus events, repository methods, metric
families, DTO fields, enum values), plus a walk of the design spec's Definition of Done. That
detector should have been a task in the original plan; it was not, which is why these surfaced
reactively.

---

## 🔴 G1 — BLOCKING: the migration has never been applied

```
Following migrations have not yet been applied:
  20260721120000_video_rooms_phase9_chat
```

No VR-9 code has ever executed against a real database. Everything is verified against mocked
Prisma plus a real DI boot. Until this is applied, none of the phase functions.

Deliberate (VR-0…VR-8 ran the same way — migrations are written, not applied, in this environment),
but it is the gate everything else waits behind.

**Before applying, read G-M1 (index drift) and G-M5 (ALTER TYPE) below.**

**Effort:** ops decision, no code.

---

## 🟠 Functional gaps — code exists but nothing invokes it

### G2 — `ChatMessageStatus` is never derived or returned

`dto/chat/chat-message.view.ts` declares all 8 values (SENDING, SENT, DELIVERED, READ, EDITED,
DELETED, RECALLED, FAILED). Nothing computes it. The API returns messages with **no status field at
all**, so a client cannot distinguish SENT from EDITED from DELETED.

This undermines a headline design decision: "status is derived, never stored" only works if
something actually derives it at read time.

Where it belongs: `VideoRoomChatService.toPayload()` and
`VideoRoomChatQueryService.toPayload()` — both already build the wire payload.
Derivation: `recalledAt ⇒ RECALLED`, `deletedAt ⇒ DELETED`, `editedAt ⇒ EDITED`, else `SENT`.
DELIVERED/READ stay client-resolved from the cursor endpoints; SENDING/FAILED are client-only.

**Effort:** ~1h including tests.

### G3 — 3 of 9 metric families are never called

```
✗ setPinnedMessages          — pin service never reports
✗ incSpamDetected            — rate limiter detects but never records
✗ incChatRateLimitViolation  — ditto
```

The phase brief's MONITORING section explicitly names *"Spam Detection"* and *"Rate Limit
Violations."* Both dashboards will read **zero forever** — worse than absent, because zero looks
like "no spam" rather than "not instrumented."

Where they belong:
- `incSpamDetected(kind)` / `incChatRateLimitViolation()` — in `VideoRoomChatRateLimiter`, at each
  rejection point (`kind` ∈ flood | duplicate | blocked_word | cooldown). Note the blocked-word
  rejection happens in `VideoRoomChatService.applyWordScan`, not the limiter.
- `setPinnedMessages(count)` — in `VideoRoomChatPinService.refreshPinCache`, which already has the
  count in hand.

Caution: the limiter is on the hot path and currently has no metrics dependency. Prefer publishing
a bus event and counting in `VideoRoomChatMetricsListener`, consistent with how every other VR-9
metric is recorded and with the decoupling rationale in the design (§5.3).

**Effort:** ~1–2h with the event-based approach.

### G4 — the `maxMentions` config knob is dead

`video-room-chat.service.ts:88` hardcodes `max: 10`; `VideoRoomChatConfig.maxMentions` is loaded,
typed, coerced and never read. Changing `VIDEO_ROOM_CHAT_MAX_MENTIONS` in env does nothing.

**Effort:** ~10min.

---

## 🟡 Audit-trail gaps

### G5 — settings changes carry no `ip` / `requestId`

`PATCH /video-rooms/:id/chat/settings` accepts `@RequestMeta()` but never forwards it.
`ChatModeChangedEvent`'s payload has no `audit` key, so the audit listener records the change
without request context — unlike every other mutating chat action.

**Effort:** ~30min (add `audit` to the event payload, thread it, extend the listener's map).

### G6 — `VideoRoomLogAction.SETTINGS_CHANGED` is never written

Same class as the five chat log actions closed in VR-9.1b; this one was scoped out and stayed open.
A chat-mode change is exactly the sort of moderator-visible action the human audit trail exists for.

**Effort:** folds into G5.

---

## ⚪ Known risks — recorded, not defects

**G-M1 — the `pg_trgm` index is invisible to Prisma. Highest-consequence item here.**
`video_room_messages_content_trgm_idx` exists ONLY in the migration SQL, because Prisma cannot
express `gin_trgm_ops` without the `postgresqlExtensions` preview feature. A future
`prisma migrate dev` compares its shadow DB (built from migrations, *with* the index) against
`schema.prisma` (*without* it) and may propose a migration that **drops** it — silently turning
keyword search into a sequential scan over millions of rows.
**This bites at G1 time.** Decide before applying: enable the preview feature, or add a guard note
to the migration, or accept and monitor.

**G-M2** — `VIDEO_ROOM_CHAT_MENTION_RE` is a module-level `/g` regex. Safe under the current
`matchAll()` usage (which clones), but any future `.test()` / `.exec()` caller on the shared
constant would carry `lastIndex` state between messages and intermittently skip mentions.

**G-M3** — `audio-rooms/repositories/chat.repository.ts` now injects `BlockedWordRepository` and
delegates 5 word methods as a pass-through layer (a Task 5 minimal-diff choice). Removable later by
repointing callers directly at the infra repository.

**G-M4** — 17 `VIDEO_ROOM_CHAT_*` env vars are absent from `env.validation.ts`. The schema is not
`.strict()` and every value has a `??` default, so nothing breaks; but a typo'd env var fails
silently to its default instead of erroring at boot.

**G-M5 — `ALTER TYPE … ADD VALUE` in the migration: SAFE HERE, but know why.**
The migration contains 5 of these against the pre-existing `VideoRoomLogAction` enum:

```sql
ALTER TYPE "VideoRoomLogAction" ADD VALUE IF NOT EXISTS 'MESSAGE_DELETED';   -- ×5
```

Prisma wraps each migration file in a transaction, and Postgres restricts this statement inside
one. Verified against the actual environment:

| Condition | This migration |
| --- | --- |
| Server version | **PostgreSQL 16.14** (`postgres:16-alpine`) — PG 12+ permits `ADD VALUE` inside a transaction |
| Are the new values *used* in the same migration? | **No.** The only `UPDATE` uses `VideoRoomChatMode`, a type freshly `CREATE TYPE`d in this same file — an unrestricted case |
| `IF NOT EXISTS` support | present, and makes re-runs idempotent |

⇒ **No action needed for this migration on this stack.**

It would become a hard failure if either changes: a target running **PostgreSQL < 12** (the whole
migration aborts with *"ALTER TYPE … ADD VALUE cannot run inside a transaction block"*), or a
**future** migration that both adds an enum value and references it in the same file. If a
lower-version environment exists anywhere in the deploy path, this needs splitting into its own
migration.

---

## ✅ Verified clean (scope of what is NOT a gap)

- All 7 new error codes are thrown somewhere.
- All 15 outbound socket events have a producer (incl. `CHAT_MODE_CHANGED`, wired in VR-9.1a).
- All 18 chat-repository methods have a caller.
- 16 of 17 config fields are consumed (the exception is G4).
- `attachments`, `forwardedFromId`, `mentionScope` are wired end-to-end (forward-ready confirmed).
- The 6 gaps found in the first DoD audit (chatMode settable, allowViewerChat mirror,
  chat_mode_changed producer, totalChatMessages, chat VideoRoomLog actions, search filters) are
  closed and re-verified by re-running the original detection greps.
- AR-4 (audio-room chat) regression gate holds: its specs pass with zero assertion edits.

---

## Suggested grouping when this is picked up

| Batch | Contents | Effort |
| --- | --- | --- |
| **A** | G1 + decide G-M1 first | ops |
| **B** | G2 (status derivation) + G4 (maxMentions) | ~1.5h |
| **C** | G3 (3 metrics, via bus events) | ~1–2h |
| **D** | G5 + G6 (settings audit context + log action) | ~45min |

B/C/D are independent of each other and of G1. None requires a database.
