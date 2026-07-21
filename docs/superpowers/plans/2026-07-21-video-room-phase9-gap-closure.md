# VR-9.2 Chat Gap Closure (G2–G6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up five VR-9 chat symbols that are declared but never invoked — the message status enum, three Prometheus metric families, the `maxMentions` config knob, the settings audit context, and the `SETTINGS_CHANGED` log action.

**Architecture:** All changes live inside `src/modules/video-rooms/`. Message status is derived at read time by a single shared mapper (never stored). Spam/rate-limit counters are recorded by publishing a domain event that the existing metrics listener subscribes to, keeping Prometheus off the send hot path. The pinned-messages gauge is set from a cross-room COUNT, because the gauge carries no room label.

**Tech Stack:** NestJS 10, TypeScript, Prisma, Jest, prom-client, Redis (ioredis), in-process EVENT_BUS.

## Global Constraints

- **NO GIT OPERATIONS.** Do not commit, push, rebase, stash, or change branches. This overrides the writing-plans skill's default "Commit" step — every task ends with a verification checkpoint instead. Leave the working tree dirty for review.
- **NO DATABASE MIGRATIONS** and no operational/deployment steps. G1 and G-M1 are handled separately, after this code is reviewed.
- **Do NOT modify `src/common/**` or `src/infra/**`.** Every file in this plan is under `src/modules/video-rooms/`.
- Reuse existing infrastructure and shared logic; do not duplicate implementations.
- Test runner is Jest, configured in `package.json` (`testRegex: ".*\\.spec\\.ts$"`). Run a single file with `npx jest <path>`.
- Existing specs construct services **positionally** with `as never` casts. Any constructor parameter added by a task **must** be added to that service's existing spec constructor call in the same task, or the suite breaks.
- Follow the surrounding comment density and idiom. These files carry explanatory block comments on non-obvious decisions; match that.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `dto/chat/chat-message.mapper.ts` | **NEW.** The single authoritative row→wire mapping + status derivation. Pure functions, no DI. |
| `dto/chat/chat-message.mapper.spec.ts` | **NEW.** Derivation precedence and payload projection tests. |
| `dto/chat/index.ts` | Barrel — export the mapper. |
| `events/video-room-chat.events.ts` | `status` on `ChatMessagePayload`; `SPAM_DETECTED` name; `ChatSpamKind`; `ChatSpamDetectedEvent`; `audit` on `ChatModeChangedEvent`. |
| `services/video-room-chat.service.ts` | Delegate `toPayload`; read `cfg.maxMentions`; publish `blocked_word` spam. |
| `services/video-room-chat-query.service.ts` | Delete private `toPayload`; use the mapper. |
| `services/video-room-system-message.service.ts` | `status: SENT` on both payload literals. |
| `services/video-room-chat-rate-limiter.service.ts` | Publish 4 spam kinds; **not** slow mode. |
| `services/video-room-chat-pin.service.ts` | Set the pinned gauge from a cross-room count. |
| `services/video-room-chat-settings.service.ts` | Accept + forward `audit`. |
| `repositories/video-room-chat.repository.ts` | **NEW METHOD** `countAllActivePins()`. |
| `listeners/video-room-chat-metrics.listener.ts` | Subscribe `SPAM_DETECTED` → 2 counters. |
| `listeners/video-room-chat-audit.listener.ts` | `CHAT_MODE_CHANGED` in `AUDITED` + `LOGGED`. |
| `controllers/video-rooms-chat.controller.ts` | Forward `@RequestMeta()` on the settings route. |
| `video-rooms.metrics.ts` | Correct the `pinnedMessages` help text. |

**Import-cycle warning (applies to Task 1).** `events/video-room-chat.events.ts` must import `ChatMessageStatus` from `'../dto/chat/chat-message.view'` — the **direct file path**, never the `dto/chat` barrel. The barrel re-exports the mapper, and the mapper imports the events file; going through the barrel would create a cycle.

---

## Task 1: Shared payload mapper + collapse all three producers onto it

Closes **G2** end to end: derives the status AND makes the API return it.

**Why one task:** adding `status` as a *required* field breaks all three payload producers the moment it lands. Splitting the mapper from the rewiring would leave the build red between tasks, so both halves ship together and the task ends green.

**Files:**
- Create: `src/modules/video-rooms/dto/chat/chat-message.mapper.ts`
- Test: `src/modules/video-rooms/dto/chat/chat-message.mapper.spec.ts`
- Modify: `src/modules/video-rooms/events/video-room-chat.events.ts` (add `status` to `ChatMessagePayload`)
- Modify: `src/modules/video-rooms/dto/chat/index.ts` (export the mapper)
- Modify: `src/modules/video-rooms/services/video-room-chat.service.ts` (~line 126)
- Modify: `src/modules/video-rooms/services/video-room-chat-query.service.ts` (~line 125, plus call sites)
- Modify: `src/modules/video-rooms/services/video-room-system-message.service.ts` (~lines 62, 85)
- Test: the three existing spec files beside those services

**Interfaces:**
- Consumes: `ChatMessageStatus` from `dto/chat/chat-message.view.ts`; `ChatMessagePayload` from `events/video-room-chat.events.ts`; `VideoRoomMessage` from `@prisma/client`.
- Produces:
  - `deriveChatMessageStatus(message: VideoRoomMessage): ChatMessageStatus`
  - `toChatMessagePayload(message: VideoRoomMessage): ChatMessagePayload`
  - `ChatMessagePayload.status: ChatMessageStatus` (now a **required** field)
  - `VideoRoomChatService.toPayload(message)` retained as a public delegating wrapper (external callers depend on it). `VideoRoomChatQueryService.toPayload` is **removed**.

- [ ] **Step 1: Write the failing test**

Create `src/modules/video-rooms/dto/chat/chat-message.mapper.spec.ts`:

```ts
import { deriveChatMessageStatus, toChatMessagePayload } from './chat-message.mapper';
import { ChatMessageStatus } from './chat-message.view';

/** A plain, never-touched message row. */
const BASE = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: 'TEXT',
  content: 'hello',
  mentions: ['u2'],
  mentionScope: null,
  replyToId: null,
  metadata: null,
  createdAt: new Date('2026-07-21T10:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  recalledAt: null,
};

const row = (over: Record<string, unknown> = {}) => ({ ...BASE, ...over }) as never;

describe('deriveChatMessageStatus', () => {
  it('returns SENT for an untouched row', () => {
    expect(deriveChatMessageStatus(row())).toBe(ChatMessageStatus.SENT);
  });

  it('returns EDITED when editedAt is set', () => {
    expect(deriveChatMessageStatus(row({ editedAt: new Date() }))).toBe(ChatMessageStatus.EDITED);
  });

  it('returns DELETED when deletedAt is set', () => {
    expect(deriveChatMessageStatus(row({ deletedAt: new Date() }))).toBe(ChatMessageStatus.DELETED);
  });

  it('returns RECALLED when recalledAt is set', () => {
    expect(deriveChatMessageStatus(row({ recalledAt: new Date() }))).toBe(
      ChatMessageStatus.RECALLED,
    );
  });

  // Precedence is the whole reason the checks are ordered. A recall soft-deletes
  // the row too, so both columns are set and RECALLED must win.
  it('prefers RECALLED over DELETED when both are set', () => {
    expect(deriveChatMessageStatus(row({ recalledAt: new Date(), deletedAt: new Date() }))).toBe(
      ChatMessageStatus.RECALLED,
    );
  });

  it('prefers DELETED over EDITED when both are set', () => {
    expect(deriveChatMessageStatus(row({ deletedAt: new Date(), editedAt: new Date() }))).toBe(
      ChatMessageStatus.DELETED,
    );
  });
});

describe('toChatMessagePayload', () => {
  it('projects the row onto the wire shape, including a derived status', () => {
    expect(toChatMessagePayload(row())).toEqual({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'u1',
      type: 'TEXT',
      content: 'hello',
      status: ChatMessageStatus.SENT,
      mentions: ['u2'],
      mentionScope: null,
      replyToId: null,
      createdAt: '2026-07-21T10:00:00.000Z',
    });
  });

  it('carries the derived status through on an edited row', () => {
    expect(toChatMessagePayload(row({ editedAt: new Date() })).status).toBe(
      ChatMessageStatus.EDITED,
    );
  });

  it('projects announcementId and systemEvent out of metadata when present', () => {
    const payload = toChatMessagePayload(
      row({ metadata: { announcementId: 'a1', systemEvent: 'user_joined' } }),
    );
    expect(payload.announcementId).toBe('a1');
    expect(payload.systemEvent).toBe('user_joined');
  });

  it('omits announcementId and systemEvent when metadata is absent', () => {
    const payload = toChatMessagePayload(row());
    expect(payload).not.toHaveProperty('announcementId');
    expect(payload).not.toHaveProperty('systemEvent');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/dto/chat/chat-message.mapper.spec.ts`
Expected: FAIL — `Cannot find module './chat-message.mapper'`.

- [ ] **Step 3: Add `status` to the payload interface**

In `src/modules/video-rooms/events/video-room-chat.events.ts`, add this import at the top (**direct file path, not the barrel** — see the import-cycle warning above):

```ts
import type { ChatMessageStatus } from '../dto/chat/chat-message.view';
```

Then add the field to `ChatMessagePayload`, directly after `content`:

```ts
export interface ChatMessagePayload {
  roomId: string;
  messageId: string;
  senderId: string;
  type: string;
  content: string;
  /**
   * Derived at read time from the row's editedAt/deletedAt/recalledAt columns —
   * never stored. SENDING/FAILED are client-only; DELIVERED/READ are
   * per-recipient facts resolved from the cursor endpoints.
   */
  status: ChatMessageStatus;
  mentions: string[];
  mentionScope: string | null;
  replyToId: string | null;
  createdAt: string;
  /** Present only on ANNOUNCEMENT projections. */
  announcementId?: string;
  /** Present only on SYSTEM rows — the domain event that produced it. */
  systemEvent?: string;
}
```

- [ ] **Step 4: Write the mapper**

Create `src/modules/video-rooms/dto/chat/chat-message.mapper.ts`:

```ts
import { VideoRoomMessage } from '@prisma/client';
import type { ChatMessagePayload } from '../../events/video-room-chat.events';
import { ChatMessageStatus } from './chat-message.view';

/**
 * VR-9.2 (G2): the status the message view has always declared but nothing ever
 * computed. Derived from the row, never stored — a stored status would need a
 * write on every edit/delete/recall and could drift from the columns that are
 * already the source of truth.
 *
 * Order is load-bearing: a recall ALSO sets `deletedAt` (a recall is a delete
 * plus a tombstone), so RECALLED must be tested before DELETED or every recalled
 * message would report as merely deleted.
 */
export function deriveChatMessageStatus(message: VideoRoomMessage): ChatMessageStatus {
  if (message.recalledAt) return ChatMessageStatus.RECALLED;
  if (message.deletedAt) return ChatMessageStatus.DELETED;
  if (message.editedAt) return ChatMessageStatus.EDITED;
  return ChatMessageStatus.SENT;
}

/**
 * The ONE row→wire mapping. Previously duplicated byte-for-byte across
 * `VideoRoomChatService` and `VideoRoomChatQueryService`, which is how they were
 * able to drift; every payload change now happens here only.
 */
export function toChatMessagePayload(message: VideoRoomMessage): ChatMessagePayload {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  return {
    roomId: message.roomId,
    messageId: message.id,
    senderId: message.senderId,
    type: message.type,
    content: message.content,
    status: deriveChatMessageStatus(message),
    mentions: message.mentions,
    mentionScope: message.mentionScope,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    ...(typeof metadata.announcementId === 'string'
      ? { announcementId: metadata.announcementId }
      : {}),
    ...(typeof metadata.systemEvent === 'string' ? { systemEvent: metadata.systemEvent } : {}),
  };
}
```

- [ ] **Step 5: Export from the barrel**

Append to `src/modules/video-rooms/dto/chat/index.ts`:

```ts
export * from './chat-message.mapper';
```

- [ ] **Step 6: Run the mapper test to verify it passes**

Run: `npx jest src/modules/video-rooms/dto/chat/chat-message.mapper.spec.ts`
Expected: PASS — 10 tests.

At this point `npx tsc --noEmit` will report "Property 'status' is missing" against the three payload producers. That is expected and is fixed by the remaining steps of this task — do not stop here.

- [ ] **Step 7: Write the failing producer tests**

Append to `src/modules/video-rooms/services/video-room-chat.service.spec.ts`, inside the top-level `describe`:

```ts
it('stamps a derived status onto the wire payload', () => {
  const payload = service.toPayload({
    id: 'm1',
    roomId: 'r1',
    senderId: 'u1',
    type: 'TEXT',
    content: 'hello',
    mentions: [],
    mentionScope: null,
    replyToId: null,
    metadata: null,
    createdAt: new Date('2026-07-21T10:00:00.000Z'),
    editedAt: new Date('2026-07-21T10:05:00.000Z'),
    deletedAt: null,
    recalledAt: null,
  } as never);

  expect(payload.status).toBe('EDITED');
});
```

Append to `src/modules/video-rooms/services/video-room-system-message.service.spec.ts`, inside the top-level `describe`:

```ts
it('marks system messages as SENT', async () => {
  const payload = await service.emit('r1', 'user_joined', 'Alice joined', {});
  expect(payload.status).toBe('SENT');
});
```

> **Note:** confirm the emit method's real name and signature by reading the service before writing this test — use whatever the existing spec in that file already calls. The assertion (`payload.status === 'SENT'`) is what matters.

- [ ] **Step 8: Run the producer tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts src/modules/video-rooms/services/video-room-system-message.service.spec.ts`
Expected: FAIL — `expect(received).toBe(expected)`, received `undefined`.

- [ ] **Step 9: Delegate in the chat service**

In `src/modules/video-rooms/services/video-room-chat.service.ts`, add the import:

```ts
import { toChatMessagePayload } from '../dto/chat/chat-message.mapper';
```

Replace the whole `toPayload` method body (currently ~lines 126–143) with:

```ts
  /**
   * The wire shape every message-carrying event and response uses. Delegates to
   * the shared mapper — kept as a method because external callers hold a
   * reference to it.
   */
  toPayload(message: VideoRoomMessage): ChatMessagePayload {
    return toChatMessagePayload(message);
  }
```

- [ ] **Step 10: Delete the query service's private copy**

In `src/modules/video-rooms/services/video-room-chat-query.service.ts`:

1. Add the import:

```ts
import { toChatMessagePayload } from '../dto/chat/chat-message.mapper';
```

2. Delete the entire `private toPayload(message: VideoRoomMessage): ChatMessagePayload { ... }` method (~lines 125–144).

3. Replace every call site. Find them first:

```bash
grep -n "this\.toPayload(" src/modules/video-rooms/services/video-room-chat-query.service.ts
```

Rewrite each `this.toPayload(r)` as `toChatMessagePayload(r)`. (Known sites at the time of writing: the `.map()` calls at ~line 76 and ~line 102 — but trust the grep, not these numbers.)

4. If `VideoRoomMessage` is now an unused import, remove it; if it is still used in other signatures, leave it.

- [ ] **Step 11: Stamp SENT on both system-message literals**

In `src/modules/video-rooms/services/video-room-system-message.service.ts`, add the import:

```ts
import { ChatMessageStatus } from '../dto/chat/chat-message.view';
```

There are **two** `ChatMessagePayload` literals — the persisted one (~line 62) and `ephemeralPayload` (~line 85). Add this line to **both**, directly after `content,`:

```ts
      status: ChatMessageStatus.SENT,
```

A system message is never edited, deleted, or recalled, so the constant is correct by construction. This literal cannot use the mapper wholesale because `ephemeralPayload` builds a payload for a message that has no database row at all.

- [ ] **Step 12: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/ src/modules/video-rooms/dto/`
Expected: PASS across the chat service, query service, system-message service, and mapper specs.

- [ ] **Step 13: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: **0 errors.** Every `ChatMessagePayload` producer now supplies `status`.

Run: `grep -rn "status" src/modules/video-rooms/dto/chat/chat-message.mapper.ts | head -3`
Expected: confirms the deriver exists — G2's "declared but never wired" condition is now broken.

---

## Task 2: Honour the `maxMentions` config knob

Closes **G4**.

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-chat.service.ts` (constructor + ~line 88)
- Test: `src/modules/video-rooms/services/video-room-chat.service.spec.ts`

**Interfaces:**
- Consumes: `loadVideoRoomChatConfig(config: ConfigService): VideoRoomChatConfig` from `config/video-room-chat.config.ts`.
- Produces: `VideoRoomChatService` constructor gains a **trailing 8th parameter** `config: ConfigService`. Task 4 modifies this same service and must preserve that parameter.

- [ ] **Step 1: Write the failing test**

In `src/modules/video-rooms/services/video-room-chat.service.spec.ts`, the service is constructed at two places (~line 46 and ~line 227). Add a `config` mock to the `beforeEach` that owns the first one:

```ts
const CHAT_CFG = {
  messageMaxLength: 500,
  maxMentions: 3,
  maxPins: 5,
  rateMax: 20,
  rateWindowSeconds: 60,
  dedupWindowSeconds: 30,
  floodBurstMax: 5,
  floodBurstWindowSeconds: 2,
  cooldownSteps: [10, 30, 120],
  recentBufferSize: 50,
  recentBufferTtlSeconds: 3600,
  typingTtlSeconds: 5,
  recallWindowSeconds: 120,
  editWindowSeconds: 300,
  receiptThrottleMs: 1000,
  systemMessageBroadcastOnlyAboveViewers: 100,
  systemMessageSuppressAboveViewers: 1000,
};
```

Declare `let config: { get: jest.Mock };` beside the other mocks, and in `beforeEach`:

```ts
config = { get: jest.fn().mockReturnValue(CHAT_CFG) };
```

Then add the test:

```ts
it('caps mention resolution at the configured maximum, not a hardcoded 10', async () => {
  await service.send(ACTOR, 'r1', { content: 'hi @a @b @c @d' });

  expect(mentions.resolve).toHaveBeenCalledWith(
    'hi @a @b @c @d',
    expect.objectContaining({ max: 3 }),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts -t "caps mention resolution"`
Expected: FAIL — the call is recorded with `max: 10`, not `max: 3`.

- [ ] **Step 3: Inject config and read the knob**

In `src/modules/video-rooms/services/video-room-chat.service.ts`, add imports:

```ts
import { ConfigService } from '@nestjs/config';
import { loadVideoRoomChatConfig } from '../config/video-room-chat.config';
```

Add a trailing constructor parameter (keep all existing parameters in order):

```ts
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly config: ConfigService,
  ) {}
```

In `send()`, load the config once near the top of the method, immediately after the `attachments` line:

```ts
    const cfg = loadVideoRoomChatConfig(this.config);
```

Then change the mention resolution call (~line 84–89) from `max: 10` to:

```ts
    const resolved = await this.mentions.resolve(content, {
      roomId,
      ownerId: room.ownerId,
      senderId: actor.id,
      max: cfg.maxMentions,
    });
```

Per-call loading matches `VideoRoomChatRateLimiter.assertMaySend`, which already does exactly this. It is a pure object read, not I/O.

- [ ] **Step 4: Update the second constructor call in the spec**

The spec builds the service a second time at ~line 227 with inline mocks. Append `config as never` as the trailing 8th argument there too, or the suite fails with a `ConfigService` undefined error.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 6: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

---

## Task 3: Spam event + the four limiter rejection points

Closes the limiter half of **G3**. The event class is declared here because this is the task whose deliverable needs it.

**Files:**
- Modify: `src/modules/video-rooms/events/video-room-chat.events.ts`
- Modify: `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.ts`
- Test: `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`

**Interfaces:**
- Produces:
  - `VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED = 'video_room.chat_spam_detected'`
  - `type ChatSpamKind = 'cooldown' | 'rate' | 'flood' | 'duplicate' | 'blocked_word'`
  - `class ChatSpamDetectedEvent extends DomainEvent<{ roomId: string; userId: string; kind: ChatSpamKind }>`
  - `VideoRoomChatRateLimiter` constructor gains a **trailing 4th parameter** `@Inject(EVENT_BUS) bus: IEventBus`.
- Consumed by: Task 4 (blocked-word publish) and Task 5 (metrics listener).

- [ ] **Step 1: Write the failing test**

In `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`:

Add the import:

```ts
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
```

Add a bus mock. Declare `let bus: { publish: jest.Mock };` beside the others, and in `beforeEach` set `bus = { publish: jest.fn().mockResolvedValue(undefined) };`, then change the construction (currently line 27) to:

```ts
    limiter = new VideoRoomChatRateLimiter(
      cache as never,
      redis as never,
      config as never,
      bus as never,
    );
```

Add a helper just below the mocks:

```ts
/** The `kind` of every SPAM_DETECTED event published during a call. */
const spamKinds = (bus: { publish: jest.Mock }) =>
  bus.publish.mock.calls
    .map(([event]: [{ name: string; payload: { kind: string } }]) => event)
    .filter((e) => e.name === VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED)
    .map((e) => e.payload.kind);
```

Add these tests:

```ts
it('publishes a cooldown spam signal when a cooldown is active', async () => {
  cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':cd:')));

  await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
  expect(spamKinds(bus)).toEqual(['cooldown']);
});

it('publishes a rate spam signal when the per-minute cap is exceeded', async () => {
  cache.increment.mockImplementation((key: string) =>
    Promise.resolve(key.includes(':rate:') ? 21 : 1),
  );

  await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
  expect(spamKinds(bus)).toEqual(['rate']);
});

it('publishes a flood spam signal on a burst', async () => {
  cache.increment.mockImplementation((key: string) => {
    if (key.includes(':flood:')) return Promise.resolve(6);
    if (key.includes(':viol:')) return Promise.resolve(1);
    return Promise.resolve(1);
  });

  await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
  expect(spamKinds(bus)).toEqual(['flood']);
});

it('publishes a duplicate spam signal on a repeated message', async () => {
  redis.set.mockImplementation((key: string) =>
    Promise.resolve(key.includes(':dedup:') ? null : 'OK'),
  );

  await expect(limiter.assertMaySend('r1', 'u1', 'hello', OPTS)).rejects.toBeDefined();
  expect(spamKinds(bus)).toEqual(['duplicate']);
});

// THE LOAD-BEARING NEGATIVE TEST. Slow mode is a room UX setting; a user hitting
// it is COMPLYING with room policy, not abusing it. Counting it as spam would
// flood the abuse dashboard with legitimate traffic.
it('publishes NO spam signal when slow mode rejects the message', async () => {
  cache.exists.mockImplementation((key: string) => Promise.resolve(key.includes(':slow:')));

  await expect(
    limiter.assertMaySend('r1', 'u1', 'hello', { rateMax: 20, slowModeSeconds: 10 }),
  ).rejects.toMatchObject({ errorCode: ERROR_CODES.CHAT_SLOW_MODE });
  expect(spamKinds(bus)).toEqual([]);
});

it('publishes nothing when the message passes every gate', async () => {
  await limiter.assertMaySend('r1', 'u1', 'hello', OPTS);
  expect(spamKinds(bus)).toEqual([]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`
Expected: FAIL — `VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED` is undefined and no publish occurs.

- [ ] **Step 3: Declare the event**

In `src/modules/video-rooms/events/video-room-chat.events.ts`, add to the `VIDEO_ROOM_CHAT_EVENTS` object, after `CHAT_MODE_CHANGED`:

```ts
  SPAM_DETECTED: 'video_room.chat_spam_detected',
```

Append at the end of the file:

```ts
/**
 * The closed set of abuse signals. A union rather than a bare string so a typo
 * cannot silently mint a new Prometheus label value and fragment the metric.
 *
 * Slow mode is deliberately ABSENT: it is a room-level UX setting, and a user
 * hitting it is complying with room policy, not abusing it.
 */
export type ChatSpamKind = 'cooldown' | 'rate' | 'flood' | 'duplicate' | 'blocked_word';

/**
 * VR-9.2 (G3): published at every abuse rejection so
 * `VideoRoomChatMetricsListener` can count it. Internal only — this must NEVER
 * be bridged to a socket broadcast, because it would leak moderation signal to
 * the room.
 */
export class ChatSpamDetectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  kind: ChatSpamKind;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED;
}
```

- [ ] **Step 4: Publish at the four abuse gates**

In `src/modules/video-rooms/services/video-room-chat-rate-limiter.service.ts`, add imports:

```ts
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { ChatSpamDetectedEvent, type ChatSpamKind } from '../events/video-room-chat.events';
```

Add the trailing constructor parameter:

```ts
    private readonly config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}
```

Add this private helper next to `tooFast`:

```ts
  /**
   * `tooFast` is a factory that RETURNS an exception rather than throwing, so
   * publication cannot be folded into it — each gate publishes, then throws.
   */
  private async spam(roomId: string, userId: string, kind: ChatSpamKind): Promise<void> {
    await this.bus.publish(new ChatSpamDetectedEvent({ roomId, userId, kind }));
  }
```

Now add a publish immediately before each of the four abuse throws. Gate 3 (slow mode) is left **untouched**:

```ts
    // 1. Serving a cooldown? Nothing else matters.
    if (await this.cache.exists(videoRoomChatCooldownKey(roomId, userId))) {
      await this.spam(roomId, userId, 'cooldown');
      throw this.tooFast('You are temporarily cooled down — please wait before sending again.');
    }

    // 2. Rolling per-minute cap.
    const rate = await this.cache.increment(videoRoomChatRateKey(roomId, userId), {
      ttlSeconds: cfg.rateWindowSeconds,
    });
    if (rate > opts.rateMax) {
      await this.spam(roomId, userId, 'rate');
      throw this.tooFast('You are sending messages too quickly.');
    }

    // 3. Room slow mode. NO spam signal — see `ChatSpamKind`.
```

```ts
    if (burst > cfg.floodBurstMax) {
      await this.armCooldown(roomId, userId, cfg.cooldownSteps);
      await this.spam(roomId, userId, 'flood');
      throw this.tooFast('Too many messages at once — slow down.');
    }
```

```ts
    if (claimed === null) {
      await this.spam(roomId, userId, 'duplicate');
      throw new BusinessException(
        ERROR_CODES.DUPLICATE_MESSAGE,
        'Duplicate message ignored.',
        HttpStatus.CONFLICT,
      );
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-rate-limiter.service.spec.ts`
Expected: PASS — the 8 pre-existing tests plus the 6 new ones.

- [ ] **Step 6: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

Run: `grep -rn "SPAM_DETECTED" src/modules/video-rooms/listeners/video-room-chat-socket.listener.ts`
Expected: **no output.** The spam event must never reach the socket bridge.

---

## Task 4: Publish the blocked-word spam signal

Completes the fifth spam kind. It lives in the chat service, not the limiter, because the word scan runs after rate limiting.

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-chat.service.ts` (~lines 81, 248–257)
- Test: `src/modules/video-rooms/services/video-room-chat.service.spec.ts`

**Interfaces:**
- Consumes: `ChatSpamDetectedEvent`, `ChatSpamKind` from Task 3.
- Produces: `applyWordScan` becomes `private async applyWordScan(content: string, roomId: string, userId: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/services/video-room-chat.service.spec.ts`:

```ts
it('publishes a blocked_word spam signal when the scan rejects a message', async () => {
  words.scan.mockReturnValue({ matched: true, action: 'BLOCK', matches: ['x'], maskedText: '' });

  await expect(service.send(ACTOR, 'r1', { content: 'bad' })).rejects.toMatchObject({
    errorCode: ERROR_CODES.BLOCKED_WORD,
  });

  const kinds = bus.publish.mock.calls
    .map(([e]: [{ name: string; payload: { kind?: string } }]) => e)
    .filter((e) => e.name === VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED)
    .map((e) => e.payload.kind);
  expect(kinds).toEqual(['blocked_word']);
});

// A MASK hit is handled, not rejected — the message still sends, so it is not
// an abuse rejection and must not be counted as one.
it('publishes NO spam signal when the scan only masks', async () => {
  words.scan.mockReturnValue({
    matched: true,
    action: 'MASK',
    matches: ['x'],
    maskedText: 'g***',
  });

  await service.send(ACTOR, 'r1', { content: 'good' });

  const spam = bus.publish.mock.calls
    .map(([e]: [{ name: string }]) => e)
    .filter((e) => e.name === VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED);
  expect(spam).toHaveLength(0);
});
```

Ensure `ERROR_CODES` and `VIDEO_ROOM_CHAT_EVENTS` are imported in the spec; add them if not.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts -t "spam signal"`
Expected: FAIL — no `SPAM_DETECTED` event is published.

- [ ] **Step 3: Make the word scan publish**

In `src/modules/video-rooms/services/video-room-chat.service.ts`, add `ChatSpamDetectedEvent` to the existing import block from `'../events/video-room-chat.events'`.

Change the call site (~line 81) to pass identity and await:

```ts
    // 4. Blocked-word scan: mask and continue, or reject. No auto-discipline.
    const finalContent = await this.applyWordScan(content, roomId, actor.id);
```

Replace the `applyWordScan` method with:

```ts
  private async applyWordScan(
    content: string,
    roomId: string,
    userId: string,
  ): Promise<string> {
    const scan = this.words.scan(content);
    if (!scan.matched) return content;
    // A MASK hit still sends — handled, not rejected, so it is not an abuse
    // signal. Only the BLOCK path is counted.
    if (scan.action === BlockedWordAction.MASK) return scan.maskedText;
    await this.bus.publish(
      new ChatSpamDetectedEvent({ roomId, userId, kind: 'blocked_word' }),
    );
    throw new BusinessException(
      ERROR_CODES.BLOCKED_WORD,
      'Your message was blocked by the community guidelines filter.',
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
```

Keep the existing doc comment above the method.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat.service.spec.ts`
Expected: PASS — all tests in the file.

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

---

## Task 5: Count spam and rate-limit violations

Turns the published events into the two dead metric families. Closes two thirds of **G3**.

**Files:**
- Modify: `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.ts`
- Test: `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`

**Interfaces:**
- Consumes: `VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED` and `ChatSpamKind` from Task 3; `incSpamDetected(kind: string)` and `incChatRateLimitViolation()` on `VideoRoomsMetrics`.

- [ ] **Step 1: Write the failing tests**

In `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`, add the two new mocks to the `metrics` object in `beforeEach`:

```ts
      incSpamDetected: jest.fn(),
      incChatRateLimitViolation: jest.fn(),
```

Add these tests:

```ts
it.each(['cooldown', 'rate', 'flood', 'duplicate', 'blocked_word'])(
  'counts %s as a spam signal',
  (kind) => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind },
      occurredAt: new Date().toISOString(),
    });
    expect(metrics.incSpamDetected).toHaveBeenCalledWith(kind);
  },
);

it.each(['cooldown', 'rate', 'flood'])(
  'counts %s as a rate-limit violation as well',
  (kind) => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind },
      occurredAt: new Date().toISOString(),
    });
    expect(metrics.incChatRateLimitViolation).toHaveBeenCalledTimes(1);
  },
);

// Duplicate and blocked-word are abuse signals, but they are not RATE limiting.
it.each(['duplicate', 'blocked_word'])(
  'does not count %s as a rate-limit violation',
  (kind) => {
    handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind },
      occurredAt: new Date().toISOString(),
    });
    expect(metrics.incChatRateLimitViolation).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`
Expected: FAIL — `handlers[...]` is not a function; nothing subscribes to `SPAM_DETECTED`.

- [ ] **Step 3: Subscribe and count**

In `src/modules/video-rooms/listeners/video-room-chat-metrics.listener.ts`, add a module-level constant above the class:

```ts
/**
 * The abuse kinds that are specifically RATE limiting, and so additionally bump
 * the rate-limit violation counter. `duplicate` and `blocked_word` are abuse
 * signals but not rate limiting, so they count as spam only.
 */
const RATE_LIMIT_KINDS = new Set<string>(['cooldown', 'rate', 'flood']);
```

Add this subscription at the end of `onModuleInit()`:

```ts
    // VR-9.2 (G3): the brief's MONITORING section names "Spam Detection" and
    // "Rate Limit Violations". Counted here rather than in the limiter so the
    // rejection path of every send stays free of a Prometheus dependency.
    this.bus.subscribe(VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED, (event) => {
      const payload = event.payload as { kind: string };
      this.metrics.incSpamDetected(payload.kind);
      if (RATE_LIMIT_KINDS.has(payload.kind)) {
        this.metrics.incChatRateLimitViolation();
      }
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-metrics.listener.spec.ts`
Expected: PASS — 10 new parameterised cases plus the pre-existing tests.

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

---

## Task 6: Fix and populate the pinned-messages gauge

Closes the last third of **G3**, and repairs a defect the gap register itself missed.

**Background the implementer needs:** `pinnedMessages` is declared as an **unlabeled** `Gauge`, but its help text says *"Currently pinned messages per room."* It cannot be both. Setting it from a per-room count would make every room clobber every other room's value. The fix is a cross-room total; a `roomId` label was rejected as an unbounded-cardinality blowup, and `inc()`/`dec()` was rejected because it drifts permanently when a pinned message is deleted or a room ends with pins active.

**Files:**
- Modify: `src/modules/video-rooms/repositories/video-room-chat.repository.ts` (after ~line 222)
- Modify: `src/modules/video-rooms/services/video-room-chat-pin.service.ts`
- Modify: `src/modules/video-rooms/video-rooms.metrics.ts` (~line 426, help text only)
- Test: `src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`, `src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`

**Interfaces:**
- Produces:
  - `VideoRoomChatRepository.countAllActivePins(): Promise<number>`
  - `VideoRoomChatPinService` constructor gains a **trailing 8th parameter** `metrics: VideoRoomsMetrics`.

- [ ] **Step 1: Write the failing tests**

In `src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`, add:

```ts
it('counts active pins across every room', async () => {
  prisma.videoRoomMessagePin.count.mockResolvedValue(7);

  await expect(repo.countAllActivePins()).resolves.toBe(7);
  expect(prisma.videoRoomMessagePin.count).toHaveBeenCalledWith({ where: { isActive: true } });
});
```

> Match the existing mock/`repo` variable names already used in that spec file.

In `src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts`, add a `metrics` mock:

```ts
let metrics: { setPinnedMessages: jest.Mock };
```

in `beforeEach`: `metrics = { setPinnedMessages: jest.fn() };`, add `repo.countAllActivePins = jest.fn().mockResolvedValue(12);` to the repo mock, and append `metrics as never` as the trailing 8th constructor argument (current call is at ~line 35).

Add these tests:

```ts
it('reports the CROSS-ROOM pin total to the gauge, not this room’s count', async () => {
  await service.pin(ACTOR, 'r1', 'm1');

  // The gauge has no room label, so a per-room value would have every room
  // silently overwrite every other room's.
  expect(metrics.setPinnedMessages).toHaveBeenCalledWith(12);
});

it('reports the gauge on unpin too', async () => {
  await service.unpin(ACTOR, 'r1', 'm1');
  expect(metrics.setPinnedMessages).toHaveBeenCalledWith(12);
});

// The pin row is already written by the time the gauge refreshes. A metrics
// failure must not fail an operation that has already succeeded.
it('still succeeds when the gauge refresh query fails', async () => {
  (repo.countAllActivePins as jest.Mock).mockRejectedValue(new Error('db down'));

  await expect(service.pin(ACTOR, 'r1', 'm1')).resolves.toBeDefined();
});
```

> Match the existing spec's `ACTOR` constant and the arguments its other `pin`/`unpin` tests pass; mirror them exactly.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`
Expected: FAIL — `countAllActivePins is not a function`, `setPinnedMessages` never called.

- [ ] **Step 3: Add the repository method**

In `src/modules/video-rooms/repositories/video-room-chat.repository.ts`, directly after `countActivePins` (~line 222):

```ts
  /**
   * Cross-room total, for the unlabeled `video_rooms_chat_pinned_messages`
   * gauge. Deliberately NOT per-room: the gauge carries no room label, so a
   * per-room value would have each room overwrite the last.
   */
  countAllActivePins(): Promise<number> {
    return this.prisma.videoRoomMessagePin.count({ where: { isActive: true } });
  }
```

- [ ] **Step 4: Set the gauge from the pin service**

In `src/modules/video-rooms/services/video-room-chat-pin.service.ts`:

1. Add `Logger` to the `@nestjs/common` import and add the metrics import:

```ts
import { VideoRoomsMetrics } from '../video-rooms.metrics';
```

2. Add a logger field and the trailing constructor parameter:

```ts
export class VideoRoomChatPinService {
  private readonly logger = new Logger(VideoRoomChatPinService.name);

  constructor(
    // ...existing parameters unchanged...
    private readonly config: ConfigService,
    private readonly metrics: VideoRoomsMetrics,
  ) {}
```

3. Replace `refreshPinCache` (~line 115):

```ts
  private async refreshPinCache(roomId: string): Promise<void> {
    const pins = await this.repo.listActivePins(roomId);
    await this.cache.setPins(
      roomId,
      pins.map((p) => p.messageId),
    );

    // VR-9.2 (G3). Guarded because the pin row is ALREADY committed by the time
    // we get here — a metrics query must never fail an operation that has
    // already succeeded.
    try {
      this.metrics.setPinnedMessages(await this.repo.countAllActivePins());
    } catch (error) {
      this.logger.warn(`Pinned-message gauge refresh failed: ${(error as Error).message}`);
    }
  }
```

- [ ] **Step 5: Correct the gauge help text**

In `src/modules/video-rooms/video-rooms.metrics.ts` (~line 426), change:

```ts
      help: 'Currently pinned messages per room',
```

to:

```ts
      help: 'Currently pinned messages across all rooms',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-pin.service.spec.ts src/modules/video-rooms/repositories/video-room-chat.repository.spec.ts`
Expected: PASS.

- [ ] **Step 7: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

---

## Task 7: Thread audit context through the settings route

Closes **G5**.

**Files:**
- Modify: `src/modules/video-rooms/events/video-room-chat.events.ts` (~line 188)
- Modify: `src/modules/video-rooms/services/video-room-chat-settings.service.ts`
- Modify: `src/modules/video-rooms/controllers/video-rooms-chat.controller.ts` (~line 299–306)
- Test: the settings service and controller specs

**Interfaces:**
- Produces: `VideoRoomChatSettingsService.update(actor, roomId, dto, audit?: ChatAuditContext)` — additive optional 4th parameter, so no existing caller breaks. `ChatModeChangedEvent` payload gains `audit?: ChatAuditContext`.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/services/video-room-chat-settings.service.spec.ts`:

```ts
it('carries the audit context onto the published event', async () => {
  const audit = { ip: '1.2.3.4', requestId: 'req-1', userAgent: 'jest' };

  await service.update(ACTOR, 'r1', { allowChat: false }, audit);

  expect(bus.publish).toHaveBeenCalledWith(
    expect.objectContaining({ payload: expect.objectContaining({ audit }) }),
  );
});
```

Append to `src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`:

```ts
it('forwards request metadata from the settings route into the service', async () => {
  const meta = { ip: '1.2.3.4', requestId: 'req-1', userAgent: 'jest' };

  await controller.updateSettings(USER as never, 'r1', { allowChat: false }, meta as never);

  expect(settings.update).toHaveBeenCalledWith(
    expect.anything(),
    'r1',
    { allowChat: false },
    expect.objectContaining({ ip: '1.2.3.4', requestId: 'req-1' }),
  );
});
```

> Match the existing spec's `USER`/`ACTOR` constants and its `settings` mock name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-settings.service.spec.ts src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`
Expected: FAIL — the published payload has no `audit`; the service is called with 3 arguments.

- [ ] **Step 3: Add `audit` to the event payload**

In `src/modules/video-rooms/events/video-room-chat.events.ts`, extend `ChatModeChangedEvent`:

```ts
export class ChatModeChangedEvent extends DomainEvent<{
  roomId: string;
  chatMode: string;
  allowChat: boolean;
  slowModeSeconds: number;
  actorId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED;
}
```

- [ ] **Step 4: Accept and forward it in the service**

In `src/modules/video-rooms/services/video-room-chat-settings.service.ts`, add `ChatAuditContext` to the existing events import, extend the signature, and pass it through:

```ts
  async update(
    actor: RoomActor,
    roomId: string,
    dto: UpdateChatSettingsDto,
    audit?: ChatAuditContext,
  ): Promise<VideoRoomSettings> {
```

```ts
        new ChatModeChangedEvent({
          roomId,
          chatMode: settings.chatMode,
          allowChat: settings.allowChat,
          slowModeSeconds: settings.slowModeSeconds,
          actorId: actor.id,
          audit,
        }),
```

- [ ] **Step 5: Forward it from the controller**

In `src/modules/video-rooms/controllers/video-rooms-chat.controller.ts`, in `updateSettings` (~line 299), rename `_meta` to `meta` and pass the audit context — reusing the controller's existing private `audit()` helper at line 69, exactly as the other mutating chat routes do:

```ts
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: UpdateChatSettingsDto,
    @RequestMeta() meta: RequestMetadata,
  ) {
    return this.settings.update(this.actor(user), id, dto, this.audit(meta));
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/services/video-room-chat-settings.service.spec.ts src/modules/video-rooms/controllers/video-rooms-chat.controller.spec.ts`
Expected: PASS.

- [ ] **Step 7: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors. In particular, no "declared but never read" warning remains on the settings route parameter.

---

## Task 8: Audit + log the chat settings change

Closes **G6** and completes **G5** by getting the threaded context actually written.

**Files:**
- Modify: `src/modules/video-rooms/listeners/video-room-chat-audit.listener.ts` (`AUDITED` ~line 9, `LOGGED` ~line 33)
- Test: `src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`

**Interfaces:**
- Consumes: `VideoRoomLogAction.SETTINGS_CHANGED` (already declared at `prisma/schema/video_rooms.prisma:93`); the `audit` payload key from Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`:

```ts
it('writes a chat mode change to the event stream with request context', () => {
  handlers[VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]({
    payload: {
      roomId: 'r1',
      actorId: 'u1',
      chatMode: 'PARTICIPANTS_ONLY',
      audit: { ip: '1.2.3.4', requestId: 'req-1', userAgent: 'jest' },
    },
    occurredAt: '2026-07-21T10:00:00.000Z',
  });

  expect(events.appendEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      roomId: 'r1',
      actorId: 'u1',
      eventType: VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED,
      payload: expect.objectContaining({ ip: '1.2.3.4', requestId: 'req-1' }),
    }),
  );
});

it('writes a SETTINGS_CHANGED row to the moderator log', () => {
  handlers[VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]({
    payload: { roomId: 'r1', actorId: 'u1', chatMode: 'PARTICIPANTS_ONLY' },
    occurredAt: '2026-07-21T10:00:00.000Z',
  });

  expect(rooms.appendLog).toHaveBeenCalledWith(
    expect.objectContaining({
      roomId: 'r1',
      actorId: 'u1',
      action: 'SETTINGS_CHANGED',
    }),
  );
});
```

> Match the existing spec's mock names (`events`, `rooms`, `handlers`) — read the file first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`
Expected: FAIL — `handlers[CHAT_MODE_CHANGED]` is not a function; nothing subscribes.

- [ ] **Step 3: Add the event to both maps**

In `src/modules/video-rooms/listeners/video-room-chat-audit.listener.ts`, add to `AUDITED`:

```ts
  [VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]: 'actorId',
```

and to `LOGGED`:

```ts
  [VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED]: {
    action: VideoRoomLogAction.SETTINGS_CHANGED,
    actorField: 'actorId',
  },
```

No other change is needed. `CHAT_MODE_CHANGED` carries no `messageId`, so the existing `?? null` fallback resolves `referenceId` correctly, and `writeLog`'s metadata block simply stays empty.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/modules/video-rooms/listeners/video-room-chat-audit.listener.spec.ts`
Expected: PASS.

- [ ] **Step 5: Verification checkpoint (no commit)**

Run: `npx tsc --noEmit`
Expected: 0 errors.

---

## Task 9: Full verification and the declared-but-never-wired sweep

This is the detector whose absence from the original VR-9 plan caused all six gaps. It is a required step here, not a reactive one.

**Files:** none modified (unless the sweep finds something).

- [ ] **Step 1: Full type check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors, build clean.

- [ ] **Step 2: Full test suite**

Run: `npx jest`
Expected: **1851+ passing**, with only the 3 pre-existing quarantined treasure-box failures. Any *new* failure must be fixed, not quarantined. The suite total should have grown by roughly 35 tests.

- [ ] **Step 3: AR-4 audio-room regression gate**

Run: `npx jest src/modules/audio-rooms`
Expected: PASS with **zero assertion edits** to any audio-room spec. If an audio-room test needed changing, a shared contract was broken — stop and report.

- [ ] **Step 4: DI boot check**

Run the project's existing DI verification (the `DI OK` check used by prior VR phases).
Expected: `DI OK`. This proves the four new injections resolve: `ConfigService` into `VideoRoomChatService`, `EVENT_BUS` into `VideoRoomChatRateLimiter`, and `VideoRoomsMetrics` into `VideoRoomChatPinService`.

- [ ] **Step 5: Run the declared-but-never-wired sweep**

For each symbol this work introduced or closed, confirm a call site exists **outside** its own definition file and spec:

```bash
cd /Users/srinivasulareddypothireddy/soulzaa-backend/src

# G2 — status must be derived somewhere other than the mapper
grep -rn "deriveChatMessageStatus\|toChatMessagePayload" --include="*.ts" modules/video-rooms | grep -v "chat-message.mapper"

# G3 — all three previously-dead metric families
grep -rn "setPinnedMessages\|incSpamDetected\|incChatRateLimitViolation" --include="*.ts" . | grep -v "video-rooms.metrics.ts"

# G4 — the config knob
grep -rn "maxMentions" --include="*.ts" modules/video-rooms | grep -v "config/video-room-chat.config.ts"

# G5/G6 — settings audit + log action
grep -rn "SETTINGS_CHANGED" --include="*.ts" modules/video-rooms
grep -rn "countAllActivePins" --include="*.ts" modules/video-rooms | grep -v "repository.ts"

# The new event must have a producer AND a consumer
grep -rn "SPAM_DETECTED\|ChatSpamDetectedEvent" --include="*.ts" modules/video-rooms
```

Expected: every command returns at least one non-spec hit. An empty result for any of them means that gap is still open.

- [ ] **Step 6: Negative sweep — the spam event must not leak to clients**

```bash
grep -rn "SPAM_DETECTED" src/modules/video-rooms/listeners/video-room-chat-socket.listener.ts
grep -rn "SPAM_DETECTED" src/modules/video-rooms/constants/video-room.constants.ts
```

Expected: **no output from either.** Spam verdicts are internal-only; bridging them to a socket broadcast would leak moderation signal into the room.

- [ ] **Step 7: Confirm the working tree is left uncommitted**

Run: `git status --short`
Expected: modified/untracked files listed, on branch `main`, **nothing committed**. Do not run any other git command.

- [ ] **Step 8: Report**

Summarise: gaps closed (G2, G3, G4, G5, G6), test count delta, sweep results, and the remaining open items — **G1** (apply migration) and **G-M1** (pg_trgm index drift), which must be decided together and before any future `prisma migrate dev`.

---

## Self-Review

**Spec coverage:** B1 shared mapper → Task 1. B2 status derivation → Task 1. B3 maxMentions → Task 2. C1 spam event → Task 3. C2 six rejection points (five published, slow mode excluded) → Tasks 3–4. C2 listener classification → Task 5. C3 pin gauge + `countAllActivePins` + help text → Task 6. D1–D3 audit threading → Task 7. D4 both listener maps → Task 8. Testing section → distributed across every task's test-first steps, plus Task 9. DoD items 1–7 → Task 9. **No spec section is unimplemented.**

**Placeholder scan:** No TBD/TODO. Every code step carries complete code. Three steps say "match the existing spec's mock names" — that is an instruction to read a real file, not a deferred decision, and the assertion content is fully specified in each case.

**Type consistency:** `deriveChatMessageStatus` / `toChatMessagePayload` are named identically in Tasks 1 and 9. `ChatSpamKind`'s five members are identical in Tasks 3, 4, 5, and 9. `countAllActivePins` is identical in Task 6 and Task 9. Constructor parameter additions are each declared in the Produces block of the task that adds them: `ConfigService` (Task 2, 8th on `VideoRoomChatService`), `EVENT_BUS` (Task 3, 4th on the limiter), `VideoRoomsMetrics` (Task 6, 8th on the pin service) — and Task 4 is flagged to preserve Task 2's parameter, since both modify the same service.
