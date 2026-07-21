# VR-9.2 — Chat System Gap Closure (G2–G6)

**Date:** 2026-07-21
**Scope:** Batches B, C, D of the VR-9 Open Gap Register.
**Explicitly out of scope:** G1 (apply migration), G-M1 (pg_trgm index drift decision),
G-M2/M3/M4/M5. Those are ops decisions handled separately, after this code is reviewed.

## Constraints (standing, from the requester)

- Reuse existing infrastructure and shared logic. Do not duplicate implementations.
- Do **not** modify `src/common/**` or `src/infra/**` unless there is a *verified production
  defect*. Every change in this spec lands inside `src/modules/video-rooms/**`.
- Do **not** run database migrations or any operational/deployment step.
- Do **not** perform any Git operation — no commit, push, rebase, stash, or branch change.
  (This overrides the brainstorming skill's default "commit the design document" step; this
  spec is written to disk and left uncommitted.)

## Problem

VR-9 shipped 23 tasks of chat implementation in which five symbols are *declared but never
wired*: an enum with no deriver, three metric families with no caller, a config field with no
reader, an audit context that is accepted and dropped, and a log action with no writer. Each
compiles, passes lint, and satisfies every task gate — and does nothing at runtime.

All five were re-verified by grep against the working tree before this spec was written:

| Gap | Verification |
| --- | --- |
| G2 `ChatMessageStatus` | 2 hits, both inside `chat-message.view.ts`, the file that declares it |
| G3 metrics | `setPinnedMessages` / `incSpamDetected` / `incChatRateLimitViolation` appear only at their definitions in `video-rooms.metrics.ts` |
| G4 `maxMentions` | 2 hits, both in `config/video-room-chat.config.ts`; `chat.service.ts:88` hardcodes `max: 10` |
| G5 settings audit | `controllers/video-rooms-chat.controller.ts:303` binds `@RequestMeta() _meta` — underscore-prefixed to silence the unused-parameter warning, never forwarded |
| G6 `SETTINGS_CHANGED` | Declared at `prisma/schema/video_rooms.prisma:93`; no writer anywhere in `src/` |

---

## Batch B — G2 (status derivation) + G4 (maxMentions)

### B1. The duplication that must be removed first

`toPayload` exists twice with byte-identical logic:

- `services/video-room-chat.service.ts:126` (public)
- `services/video-room-chat-query.service.ts:125` (private)

and a third `ChatMessagePayload` literal is hand-built at
`services/video-room-system-message.service.ts:62`.

`status` is a **required** field. Adding it to three copies independently is precisely how they
drift apart again. This duplication sits directly in the path of the change, so removing it is
in scope; no unrelated refactoring is included.

**Decision (confirmed): a single authoritative mapper.**

New file `dto/chat/chat-message.mapper.ts`, exporting two pure functions:

```ts
export function deriveChatMessageStatus(row: VideoRoomMessage): ChatMessageStatus
export function toChatMessagePayload(row: VideoRoomMessage): ChatMessagePayload
```

- Both call sites above delegate to `toChatMessagePayload`.
- `VideoRoomChatService.toPayload()` is retained as a thin delegating wrapper — it is public
  and called from outside the class; removing it would widen the diff past this spec's scope.
- `VideoRoomChatQueryService.toPayload()` (private) is deleted; callers use the mapper.
- The system-message literal gains `status: ChatMessageStatus.SENT`. It cannot use the mapper
  wholesale — it builds a payload for both persisted and *ephemeral* (no-row) messages — so it
  sets the field explicitly. This is the one place the constant is written by hand, and it is
  correct by construction: a system message is never edited, deleted, or recalled.
- Exported from `dto/chat/index.ts` alongside the existing DTO barrel.

Future payload changes are then made in one place only.

### B2. Status derivation

Precedence matters — a recalled row is also soft-deleted, so `recalledAt` must be tested first:

```
recalledAt != null  ->  RECALLED
deletedAt  != null  ->  DELETED
editedAt   != null  ->  EDITED
otherwise           ->  SENT
```

The three columns exist at `prisma/schema/video_rooms_chat.prisma:57,59,61`.

`SENDING` and `FAILED` remain client-only (no server row exists yet). `DELIVERED` and `READ`
remain per-recipient facts resolved from `video_room_chat_cursors` via the existing cursor
endpoints — they are never properties of the message row. This matches the contract already
documented at `dto/chat/chat-message.view.ts:5-9`; the enum is not changed.

`ChatMessagePayload` gains `status: ChatMessageStatus` as a **required** field, aligning it
with `ChatMessageView.status`, which is already declared required.

**Accepted consequence — stale Redis buffer.** The recent-message ring buffer holds JSON
serialized by the current code. Entries written before this change carry no `status`. The
buffer is capped and short-lived, so it self-heals within minutes of deploy. No cache
migration, versioning, or backfill is added; a read-path default is deliberately *not* added
either, because that would mask a genuine future omission.

### B3. G4 — maxMentions

`services/video-room-chat.service.ts:88` changes `max: 10` to `max: cfg.maxMentions`.

The service gains `ConfigService` and calls `loadVideoRoomChatConfig(this.config)`, mirroring
`VideoRoomChatRateLimiter.assertMaySend` exactly (which loads config per call). The existing
per-call load pattern is followed rather than introducing a new caching scheme, for
consistency; config loading is a pure object read, not I/O.

---

## Batch C — G3 (three metric families)

### C1. Spam and rate-limit counters, via the event bus

**Decision (confirmed): bus events, not direct metrics injection.** This keeps
`VideoRoomChatRateLimiter` free of a Prometheus dependency and matches how all six live VR-9
metric families are already recorded (see the rationale comment at
`listeners/video-room-chat-metrics.listener.ts:8-13`). The events are additionally reusable by
a future moderation phase.

New event name on `VIDEO_ROOM_CHAT_EVENTS`:

```
SPAM_DETECTED: 'video_room.chat_spam_detected'
```

New class `ChatSpamDetectedEvent` with payload `{ roomId, userId, kind }`, where `kind` is a
closed union — not a loose `string` — so a typo cannot silently create a new label value and
fragment the metric:

```ts
export type ChatSpamKind = 'cooldown' | 'rate' | 'flood' | 'duplicate' | 'blocked_word';
```

`VideoRoomsMetrics.incSpamDetected(kind: string)` keeps its existing `string` signature; it
lives in a file this spec otherwise only touches for a help-text correction, and narrowing it
is not required to make the union load-bearing at every call site.

**This event is internal-only.** It must NOT be added to the socket listener's bridge map —
broadcasting spam verdicts to the room would leak moderation signal to clients.

### C2. Rejection points and their classification

`assertMaySend` evaluates five gates; a sixth rejection lives in
`VideoRoomChatService.applyWordScan`. Five of the six publish:

| # | Gate | Location | `kind` | Also a rate-limit violation? |
| --- | --- | --- | --- | --- |
| 1 | Cooldown active | limiter §1 | `cooldown` | yes |
| 2 | Per-minute cap | limiter §2 | `rate` | yes |
| 3 | Slow mode | limiter §3 | *(none — not published)* | no |
| 4 | Burst / flood | limiter §4 | `flood` | yes |
| 5 | Duplicate | limiter §5 | `duplicate` | no |
| 6 | Blocked word | `applyWordScan` | `blocked_word` | no |

**Slow mode is deliberately excluded (confirmed).** Slow mode is a room-level UX / rate-control
setting; a user hitting it is complying with room policy, not abusing it. Counting it as spam
would inflate the abuse dashboard with legitimate traffic and destroy the metric's meaning.

`incSpamDetected(kind)` fires for all five published kinds. `incChatRateLimitViolation()` fires
only for `cooldown | rate | flood` — the three genuine anti-abuse gates. `duplicate` and
`blocked_word` are abuse signals but not *rate* limiting, so they are counted as spam only.

**Mechanics.** `tooFast()` is a factory returning an exception (`throw this.tooFast(...)`), not
a thrower, so publication cannot be folded into it. A private async helper is added:

```ts
private async spam(roomId: string, userId: string, kind: ChatSpamKind): Promise<void> {
  await this.bus.publish(new ChatSpamDetectedEvent({ roomId, userId, kind }));
}
```

Each rejection site becomes `await this.spam(...)` immediately before its `throw`. The limiter
gains `@Inject(EVENT_BUS)`.

The metrics listener subscribes once to `SPAM_DETECTED` and performs both increments.

### C3. The pinned-messages gauge — a defect the register missed

`video-rooms.metrics.ts:84` declares `pinnedMessages` as an **unlabeled** `Gauge`, while its
help text (line 426) reads *"Currently pinned messages per room."* It cannot be both. The
register's proposed fix — call `setPinnedMessages(count)` from `refreshPinCache(roomId)`, which
"already has the count in hand" — would have shipped a gauge where every room's value silently
overwrites every other room's. Last-writer-wins, meaningless under any multi-room load.

Rejected alternatives: a `roomId` label (unbounded cardinality — millions of rooms, a textbook
Prometheus blowup) and incremental `inc()`/`dec()` (drifts permanently and unrecoverably
whenever a pinned message is deleted or a room ends with pins still active — a gauge that
silently reads wrong is the exact failure mode this whole gap register exists to prevent).

**Decision (confirmed): a global cross-room total, re-queried.**

- New repository method on `VideoRoomChatRepository`, adjacent to the existing
  per-room `countActivePins(roomId)` at line 220:

  ```ts
  countAllActivePins(): Promise<number> {
    return this.prisma.videoRoomMessagePin.count({ where: { isActive: true } });
  }
  ```

- `VideoRoomChatPinService.refreshPinCache` (line 115) additionally calls
  `this.metrics.setPinnedMessages(await this.repo.countAllActivePins())`. The service gains a
  `VideoRoomsMetrics` dependency.
- The help text is corrected to *"Currently pinned messages across all rooms."*

This is self-correcting at every pin and unpin, carries no cardinality risk, and costs one
indexed COUNT on an operation that is rare and already off the hot path (it runs inside the
existing pin lock, after a `listActivePins` query).

**Note on the metrics dependency.** Unlike the spam counters, this one is injected directly
rather than routed through the bus. The two are not inconsistent: the spam counters sit on the
*rejection path of every send* (hot), whereas pin refresh is a rare, already-async, already-
locked administrative operation, and the gauge needs a queried absolute value rather than an
event count. Routing it through the bus would mean the listener re-querying the repository,
adding indirection for no decoupling benefit.

---

## Batch D — G5 (settings audit context) + G6 (SETTINGS_CHANGED)

The two are one change; G6 folds into G5.

1. `ChatModeChangedEvent`'s payload gains `audit?: ChatAuditContext`, matching every other
   mutating chat event.
2. `VideoRoomChatSettingsService.update()` accepts an optional trailing
   `audit?: ChatAuditContext` and passes it into the published event. The signature change is
   additive and optional, so no existing caller breaks.
3. `controllers/video-rooms-chat.controller.ts:303` renames `_meta` to `meta` and forwards
   `this.audit(meta)` — reusing the controller's existing private `audit()` helper (line 69),
   exactly as the other mutating chat routes already do.
4. `listeners/video-room-chat-audit.listener.ts` adds `CHAT_MODE_CHANGED` to **both** maps:
   - `AUDITED` with actor field `actorId` → writes the `video_room_events` row carrying `ip`,
     `requestId`, and `userAgent` (**closes G5**).
   - `LOGGED` as `{ action: VideoRoomLogAction.SETTINGS_CHANGED, actorField: 'actorId' }` →
     writes the human-readable `VideoRoomLog` row (**closes G6**).

`CHAT_MODE_CHANGED` already has a socket-listener subscriber; adding audit subscribers is
additive and does not affect that bridge. The event carries no `messageId`, so the audit row's
`referenceId` resolves to `null` through the existing `?? null` path — no listener change is
needed for that.

---

## Files touched

All inside `src/modules/video-rooms/`. No `src/common/**` or `src/infra/**` changes.

| File | Change |
| --- | --- |
| `dto/chat/chat-message.mapper.ts` | **new** — `deriveChatMessageStatus`, `toChatMessagePayload` |
| `dto/chat/index.ts` | export the mapper |
| `events/video-room-chat.events.ts` | `status` on `ChatMessagePayload`; `SPAM_DETECTED` name; `ChatSpamDetectedEvent`; `audit` on `ChatModeChangedEvent` |
| `services/video-room-chat.service.ts` | delegate `toPayload`; `cfg.maxMentions`; publish `blocked_word` spam; inject `ConfigService` |
| `services/video-room-chat-query.service.ts` | delete private `toPayload`, use mapper |
| `services/video-room-system-message.service.ts` | `status: SENT` on both payload literals |
| `services/video-room-chat-rate-limiter.service.ts` | inject `EVENT_BUS`; publish 4 spam kinds |
| `services/video-room-chat-pin.service.ts` | inject metrics; set gauge in `refreshPinCache` |
| `services/video-room-chat-settings.service.ts` | accept + forward `audit` |
| `repositories/video-room-chat.repository.ts` | **new method** `countAllActivePins()` |
| `listeners/video-room-chat-metrics.listener.ts` | subscribe `SPAM_DETECTED` → 2 counters |
| `listeners/video-room-chat-audit.listener.ts` | `CHAT_MODE_CHANGED` in `AUDITED` + `LOGGED` |
| `controllers/video-rooms-chat.controller.ts` | forward `@RequestMeta()` on the settings route |
| `video-rooms.metrics.ts` | correct `pinnedMessages` help text |
| *(+ the corresponding `.spec.ts` for each)* | tests |

---

## Testing

Test-driven, per batch, against the existing spec files.

- **Mapper** (new spec): all four derivation branches, including the recalled-and-deleted
  precedence case where both columns are set.
- **Query / chat / system-message services:** assert `status` is present and correct on every
  read path — list, search, send, and system projection.
- **Rate limiter:** assert the event publishes with the right `kind` at each of the four
  limiter rejection points, and — the load-bearing negative test — that the **slow-mode
  rejection publishes nothing**.
- **Chat service:** `blocked_word` publishes on a REJECT scan; a MASK scan does not.
- **Metrics listener:** `SPAM_DETECTED` increments `incSpamDetected` for all five kinds, and
  `incChatRateLimitViolation` for exactly `cooldown | rate | flood`.
- **Pin service:** `refreshPinCache` sets the gauge from `countAllActivePins`, not from the
  per-room list length.
- **Audit listener:** `CHAT_MODE_CHANGED` produces both a `video_room_events` row carrying
  `ip`/`requestId` and a `VideoRoomLog` row with action `SETTINGS_CHANGED`.
- **Controller:** the settings route forwards request metadata into the service.
- **Config:** `maxMentions` is honoured — a non-default value changes the resolver's `max`.

## Definition of Done

1. `tsc` reports 0 errors; build clean.
2. Full suite passes — expect **1851+/1854**, with the 3 quarantined treasure-box failures
   unchanged and no new quarantine.
3. `DI OK` boot check passes (the new `ConfigService`, `EVENT_BUS`, and `VideoRoomsMetrics`
   injections all resolve).
4. Module boundary check unchanged.
5. **AR-4 regression gate:** audio-room chat specs pass with zero assertion edits.
6. **The declared-but-never-wired sweep is re-run** over every symbol this work touches — for
   each declared symbol, grep for a call site outside its own definition and spec file. This is
   the detector whose absence from the original plan caused these six gaps; here it is a
   required, explicit step, not a reactive one.
7. Nothing is committed; the working tree is left for review.
