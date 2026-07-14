# Chat — Part 4 Backend Addendum

**Status:** proposed, not implemented
**Blocks:** Flutter Part 4 (One-to-One Conversation Screen)
**Scope:** additive only. No existing endpoint, event, payload or column changes meaning. Every change below is a new column, new table, new route or new event — the Part 1–3 Flutter client keeps working untouched.

---

## Why this document exists

The Part 4 conversation-screen spec asks for four features that have **no representation in the chat module today**. They cannot be built on the client without either lying to the user (device-local "starred" that vanishes on reinstall) or shipping dead buttons. Rather than fake them, we add the backend surface first.

| Feature | Today | Needed |
|---|---|---|
| Starred messages | no table, no field, no route | §1 |
| Pinned message banner | `Conversation` has no pin; `isPinned` is *conversation-in-list* pinning, a different thing | §2 |
| Delete for me (per message) | `POST /messages/:id/delete` is delete-for-**everyone**; `ConversationParticipant.clearedAt` is delete-for-me at *conversation* scope | §3 |
| Link previews | no field; `metadata` is reserved for GIFT / PROFILE_SHARE / ROOM_INVITE / CALL_LOG | §4 |
| Conversation wallpaper | no field | §5 (optional, 1 column) |
| In-conversation message search | no route | §6 (**deferred** — specced, not scheduled) |

### Explicitly *not* changing

- **Message Info (delivered-at / read-at per message).** No backend change needed. `message.delivered` and `message.read` already carry `deliveredAt` / `readAt`. When a watermark advances past message *M*, that timestamp **is** the receipt time for every message the advance newly covers, and the client persists it. Per-message receipt rows would be `O(messages × participants)` — precisely what `ConversationParticipant`'s watermark design exists to avoid. Do not add them.
- **Header "current game" / "current PK battle".** Presence is owned by the social module (`SocialPresence` = `status`, `online`, `lastSeenAt`, `currentRoomId`). Extending it is a *presence* change, not a chat one, and belongs in its own ticket. Part 4 will render audio-room activity, online and last-seen — the three presence actually returns.
- **Forward.** Needs no endpoint. Forwarding is sending a new message, with the same `content`/`type`/`metadata`, to another conversation — `POST /chat/conversations/:id/messages` already does it.

---

## 1. Starred messages

Starring is **private**: the peer never learns a message was starred. That makes its fan-out audience the owner's own devices, exactly like `draft` and `isPinned` — see the `CONVERSATION_SETTINGS` precedent.

### 1.1 Schema (`prisma/schema/chat.prisma`)

```prisma
/// A message a user has starred. Private to that user — the peer is never told,
/// so the fan-out is addressed to the owner's devices only (multi-device sync),
/// exactly like a draft or a pin/archive setting.
///
/// `conversationId` is denormalised so "list my starred messages", optionally
/// scoped to one chat, is a single indexed read with no join back to the message
/// table just to order or filter.
model StarredMessage {
  id             String   @id @default(uuid()) @db.Uuid
  messageId      String   @db.Uuid
  userId         String   @db.Uuid
  conversationId String   @db.Uuid
  createdAt      DateTime @default(now())

  message DirectMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId])
  @@index([userId, createdAt(sort: Desc)])
  @@index([userId, conversationId, createdAt(sort: Desc)])
  @@map("starred_messages")
}
```

Add to `model DirectMessage`:

```prisma
  starredBy StarredMessage[]
```

### 1.2 View

`MessageView` gains a **requester-scoped** flag, mirroring `ReactionView.reactedByMe`:

```ts
  /// Whether the requesting user has starred this message. Never reveals the peer's stars.
  isStarred: boolean;
```

`chat-view.mapper.ts` must hydrate it per page in one query, never per row:

```ts
const starred = new Set(
  (await this.prisma.starredMessage.findMany({
    where: { userId, messageId: { in: messageIds } },
    select: { messageId: true },
  })).map((s) => s.messageId),
);
// ...then isStarred: starred.has(m.id)
```

New view for the Starred screen — it must render *which chat* each message came from:

```ts
export interface StarredMessageView {
  message: MessageView;
  conversationId: string;
  /// The other participant in the conversation the message was starred in.
  peer: SocialUserCard;
  starredAt: Date;
}
```

### 1.3 Routes (`messages.controller.ts`, + a new `starred` route)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/chat/messages/:messageId/star` | — | `{ starred: true }` |
| `POST` | `/chat/messages/:messageId/unstar` | — | `{ starred: false }` |
| `GET` | `/chat/starred` | query: `conversationId?`, `page`, `limit`, `cursor?` | `Paginated<StarredMessageView>` |

All `@NotGuest()`. `GET /chat/starred` extends `PaginationQueryDto` with an optional `@IsUUID() conversationId?`, and keysets on the last starred-row id, matching `ListConversationsDto.cursor`.

### 1.4 Rules

- `requireParticipant(message.conversationId, userId)` — same gate as every other message action.
- Cannot star a soft-deleted message (`isDeleted`) → `DM_NOT_FOUND`.
- Cannot star a message the user has hidden (§3) → `DM_NOT_FOUND`. Hiding a starred message **removes the star** (do it in the same transaction as the hide).
- Star is idempotent: re-starring is a no-op, not a 409 (`@@unique` + `upsert`).
- Cap at `chat.maxStarred` (default 5 000) → `STAR_LIMIT_REACHED`. An uncapped per-user table is an availability bug waiting to happen.
- A message deleted-for-everyone cascades (`onDelete: Cascade`) — but soft-delete does not, so `deleteMessage()` must also drop star rows for that message, or the Starred screen will list tombstones.

### 1.5 Event

```ts
// events/chat.events.ts
export class MessageStarredEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    messageId: string;
    starred: boolean;
    starredAt: string | null;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_STARRED;
}
```

- `CHAT_EVENTS.MESSAGE_STARRED = 'chat.message_starred'`
- `CHAT_SOCKET_EVENTS.MESSAGE_STARRED = 'message.starred'`
- **`recipientIds = [userId]`** — the owner only. Sending this to the peer would leak a private action.

---

## 2. Pinned message (the thread banner)

⚠️ **Naming.** `UpdateConversationSettingsDto.isPinned` already means *pin this conversation to the top of the Chats list*. This is a different feature — a message pinned inside a thread. Do **not** overload the word, or the two will be confused forever. Paths below use `pinned-message`.

One pinned message per conversation (single-slot). The UI is a single banner; a list of pins is a different design and can come later without a migration (`pinnedMessageId` → join table) if ever needed.

Unlike starring, a pin is **shared** — both participants see the banner, and either may pin.

### 2.1 Schema — add to `model Conversation`

```prisma
  /// The message pinned to the top of the thread, shown as a banner. Shared: both
  /// participants see it, and either may pin — unlike a star, which is private.
  /// Referenced by id with no FK, exactly like `lastMessageId`: chat's own
  /// denormalised pointers stay pointers, so a message delete cannot cascade a
  /// conversation row away.
  pinnedMessageId String?   @db.Uuid
  pinnedBy        String?   @db.Uuid
  pinnedAt        DateTime?
```

### 2.2 View — add to `ConversationView`

```ts
  /// The pinned-banner message, or null. Hidden from a user whose `clearedAt`
  /// cut-off is newer than the pinned message — they cleared it, so they must not
  /// see it resurrected in a banner.
  pinned: { message: MessageView; pinnedBy: string; pinnedAt: Date } | null;
```

### 2.3 Routes (`conversations.controller.ts`)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/chat/conversations/:id/pinned-message` | `{ messageId: string }` | `ConversationView` |
| `DELETE` | `/chat/conversations/:id/pinned-message` | — | `ConversationView` |

Both `@NotGuest()`. Declare them **before** any parametric sibling, per the router's existing ordering rule.

### 2.4 Rules

- `requireParticipant`.
- The message must belong to **this** conversation, and not be `isDeleted` → `DM_NOT_FOUND`.
- Cannot pin a message the pinner has hidden (§3).
- Pinning replaces the existing pin (single slot) — no `PIN_LIMIT_REACHED` here.
- `deleteMessage()` (delete-for-everyone) **must clear the pin** if the deleted message was pinned, and emit the §2.5 event with `message: null`. Otherwise the banner outlives the message.
- `clearHistory()` does not clear the pin (it is shared), but the mapper returns `pinned: null` for a user whose `clearedAt >= pinnedMessage.createdAt`.

### 2.5 Event

```ts
export class ConversationPinnedMessageEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    message: MessageView | null; // null = unpinned
    pinnedBy: string | null;
    pinnedAt: string | null;
  }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_PINNED_MESSAGE;
}
```

- `CHAT_EVENTS.CONVERSATION_PINNED_MESSAGE = 'chat.conversation_pinned_message'`
- `CHAT_SOCKET_EVENTS.CONVERSATION_PINNED_MESSAGE = 'conversation.pinned_message'`
- `recipientIds` = **both** participants.

---

## 3. Delete for me (per-message hide)

`ConversationParticipant.clearedAt` hides *everything before a cut-off*. This hides *one message, for one user*, leaving the peer's copy untouched.

**The existing `POST /chat/messages/:messageId/delete` does not change.** It stays sender-only, soft-delete, fan-out-to-both — i.e. delete-for-everyone. Adding a `scope` body param would silently re-point an endpoint the shipped client already calls; a new route cannot.

No tombstone is rendered for a hide: the message simply ceases to exist for that user. (Delete-for-everyone keeps its `isDeleted` tombstone — the two are different products and must look different.)

### 3.1 Schema

```prisma
/// "Delete for me" at message granularity. `ConversationParticipant.clearedAt`
/// already hides everything before a cut-off; this hides a single message for a
/// single user without touching the peer's copy. There is no un-hide: the row is
/// the user's decision, and history queries anti-join against it.
model HiddenMessage {
  id             String   @id @default(uuid()) @db.Uuid
  messageId      String   @db.Uuid
  userId         String   @db.Uuid
  conversationId String   @db.Uuid
  createdAt      DateTime @default(now())

  message DirectMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([messageId, userId])
  @@index([userId, conversationId])
  @@map("hidden_messages")
}
```

Add to `model DirectMessage`:

```prisma
  hiddenBy HiddenMessage[]
```

### 3.2 Route

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/chat/messages/:messageId/hide` | — | `{ hidden: true }` |

`@NotGuest()`. **Any participant may hide any message** — their own or the peer's. That is the entire point of delete-for-me, and it is what separates it from `delete`, which is sender-only.

### 3.3 The two query changes this forces

**(a) History** — `message.repository.ts` `history()` must anti-join the requester's hidden set:

```ts
where: {
  conversationId,
  ...(clearedAt ? { createdAt: { gt: clearedAt } } : {}),
  NOT: { hiddenBy: { some: { userId } } },
  ...
}
```

The `@@unique([messageId, userId])` index serves this anti-join. This is the one hot-path change in the addendum — benchmark it against a 100k-message conversation before merge.

**(b) Conversation-list preview** — `Conversation.lastMessage*` is denormalised and **shared**, so a user who hides the newest message would still see it as their list preview. The mapper must, *only when* `lastMessageId` is in the requester's hidden set, fall back to their newest non-hidden message:

```ts
// Rare path — one extra indexed read, and only for a conversation whose last
// message this particular user hid. Do not pay for it on every row.
```

Do not add a per-user preview column for this. The fallback is cheap because it is rare.

Also: hiding removes the user's star for that message (§1.4), in the same transaction.

### 3.4 Event

```ts
export class MessageHiddenEvent extends DomainEvent<
  Addressed & { conversationId: string; messageId: string }
> {
  readonly name = CHAT_EVENTS.MESSAGE_HIDDEN;
}
```

- `CHAT_EVENTS.MESSAGE_HIDDEN = 'chat.message_hidden'`
- `CHAT_SOCKET_EVENTS.MESSAGE_HIDDEN = 'message.hidden'`
- **`recipientIds = [userId]`** — owner's devices only. The peer must never learn their message was hidden.

---

## 4. Link previews

The heaviest item, because it is the only one that makes the server **fetch an attacker-supplied URL**. Treat it as a security feature that happens to render a card.

### 4.1 Schema

```prisma
enum LinkPreviewStatus {
  PENDING
  READY
  FAILED
}

/// Cached Open Graph metadata for a URL, keyed by a hash of the normalised URL so
/// a link shared a thousand times is scraped once. FAILED is cached too — a dead
/// link must not be re-fetched on every render.
model LinkPreview {
  id          String            @id @default(uuid()) @db.Uuid
  /// SHA-256 of the normalised URL. Hashed because a raw URL is too long to index.
  urlHash     String            @unique
  url         String
  title       String?
  description String?
  siteName    String?
  /// S3 key of the thumbnail *we re-hosted*, never a remote URL: hotlinking would
  /// leak every reader's IP to the link's origin and rot when the origin does.
  imageKey    String?
  imageWidth  Int?
  imageHeight Int?
  status      LinkPreviewStatus @default(PENDING)
  fetchedAt   DateTime?
  /// Re-scrape after this instant. A confidently stale title is worse than none.
  expiresAt   DateTime?
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt

  messages DirectMessage[]

  @@index([expiresAt])
  @@map("link_previews")
}
```

Add to `model DirectMessage`:

```prisma
  linkPreviewId String?      @db.Uuid
  linkPreview   LinkPreview? @relation(fields: [linkPreviewId], references: [id], onDelete: SetNull)

  @@index([linkPreviewId])
```

### 4.2 View — add to `MessageView`

```ts
  linkPreview: LinkPreviewView | null;
```

```ts
export interface LinkPreviewView {
  url: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  title: string | null;
  description: string | null;
  siteName: string | null;
  /// Resolved against the CDN base by the client, exactly like `AttachmentView.storageKey`.
  imageKey: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
}
```

The client renders nothing for `PENDING`/`FAILED` — no skeleton that might never resolve.

### 4.3 Flow

1. **`sendMessage`** (type `TEXT` only): extract the first URL from `content` with a strict `https?://` matcher. No URL → nothing changes, zero added cost on the hot path.
2. Look up `LinkPreview` by `urlHash`:
   - **`READY` and not expired** → attach `linkPreviewId`. The preview ships on the very first render; no job, no second event.
   - **otherwise** → `upsert` a `PENDING` row, attach it, and enqueue a job. `sendMessage` **must not block on the fetch** — the message posts at its normal latency.
3. **Worker** on the existing `MEDIA_PROCESSING` queue (`src/infra/queue`, `QUEUE_NAMES.MEDIA_PROCESSING` — it already fetches and re-hosts media; this is the same job shape). It scrapes under the §4.4 guards, re-hosts the image through `infra/storage` under a new `chat-link-previews` category, and flips the row to `READY` or `FAILED`.
4. Worker emits §4.5, and both participants patch the bubble in place.

Retries/DLQ come free from the queue infra. A job that exhausts retries lands in `dead-letter` and the row stays `FAILED`.

### 4.4 SSRF and abuse guards — non-negotiable

This endpoint fetches a URL that a hostile user chose. Every one of these is required:

- **Resolve DNS and reject** loopback, private (RFC1918), link-local, CGNAT, and cloud-metadata (`169.254.169.254`) addresses — for **IPv4 and IPv6**.
- **Re-validate on every redirect.** Checking only the first hop is a TOCTOU hole: bind an agent-level check that validates the *resolved socket address* of each connection, not just the URL string. A DNS record that flips between the check and the connect defeats string-level validation.
- Max **3 redirects**, **5 s** total timeout, **512 KB** body cap (stream and abort — do not buffer an unbounded response).
- Accept **`text/html` only**; ignore any other content type.
- Parse **OG / Twitter card tags only**. Clamp `title` to 200 chars, `description` to 500. Strip control characters.
- Thumbnail: `image/*` only, **≤ 2 MB**, re-encoded, dimensions validated. Never store a remote URL.
- **Rate-limit scraping per user** on the existing Redis counter (`chatRateKey` is the pattern) — one user must not be able to drive the crawler.
- Honour a configurable **domain denylist**.
- The crawler must run with **no ambient credentials** and egress through the same allowlist as other outbound fetches.

### 4.5 Event

```ts
export class MessagePreviewReadyEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    messageId: string;
    preview: LinkPreviewView | null; // null when the scrape FAILED
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_PREVIEW;
}
```

- `CHAT_EVENTS.MESSAGE_PREVIEW = 'chat.message_preview'`
- `CHAT_SOCKET_EVENTS.MESSAGE_PREVIEW = 'message.preview'`
- `recipientIds` = both participants.

---

## 5. Conversation wallpaper *(optional — one column)*

The Part 4 conversation menu lists Wallpaper. If it should follow the user across devices (it should — a wallpaper that resets on reinstall reads as a bug), it is one column and **zero new events**, because the existing settings event already carries per-user conversation state.

Add to `model ConversationParticipant`:

```prisma
  /// Per-user chat wallpaper: a preset id, or an S3 key for a custom upload.
  /// Synced across the owner's devices via the existing CONVERSATION_SETTINGS event.
  wallpaper String?
```

- `UpdateConversationSettingsDto` gains `@IsOptional() @IsString() @MaxLength(512) wallpaper?: string`.
- `ConversationSelfView` gains `wallpaper: string | null`.
- `ConversationSettingsChangedEvent` payload gains `wallpaper: string | null`.
- No new route: `PUT /chat/conversations/:id/settings` already carries it.

Say the word and I'll fold this in; leave it out and Part 4 makes wallpaper device-local.

---

## 6. In-conversation message search *(DEFERRED — specced for later)*

Not scheduled for this addendum. Recorded so the eventual implementation does not have to re-derive it.

| Method | Path | Query |
|---|---|---|
| `GET` | `/chat/conversations/:id/messages/search` | `q` (1–64), `type?` (DirectMessageType), `from?` (senderId), `dateFrom?`, `dateTo?`, `cursor?`, `limit` |

Returns `Paginated<MessageView>`, newest-first, keyset on message id.

- Index: a generated `tsvector` column over `content` with a **GIN** index (`to_tsvector('simple', content)`), plus a `pg_trgm` GIN index if partial/type-ahead matching is wanted — full-text alone will not match `"paym"` against `"payment"`.
- **Must apply the same visibility filters as `history()`**: exclude `isDeleted`, exclude the requester's `HiddenMessage` rows (§3), and exclude anything at or before their `clearedAt`. A search that surfaces a message the user deleted for themselves is a privacy bug.
- Rate-limit per user; it is an unindexed-scan magnet if the filters are wrong.

---

## 7. Implementation checklist

**Schema** — `prisma/schema/chat.prisma`
- [ ] `model StarredMessage` (+ `DirectMessage.starredBy`)
- [ ] `model HiddenMessage` (+ `DirectMessage.hiddenBy`)
- [ ] `enum LinkPreviewStatus`, `model LinkPreview` (+ `DirectMessage.linkPreviewId` / `linkPreview` / index)
- [ ] `Conversation.pinnedMessageId` / `pinnedBy` / `pinnedAt`
- [ ] *(optional §5)* `ConversationParticipant.wallpaper`
- [ ] One migration under `prisma/schema/migrations/` — all additive, all nullable or defaulted, so it is safe to deploy ahead of the client.

**Errors** — `src/common/exceptions/error-codes.ts` (chat block, ~line 131)
- [ ] `STAR_LIMIT_REACHED`
- [ ] *(§4)* `LINK_PREVIEW_DISABLED` — only if the feature is flagged off per-environment

**Config** — `src/config/configuration.ts`, `registerAs('chat')` (~line 245) + the env schema
- [ ] `maxStarred: env.CHAT_MAX_STARRED` (default 5000)
- [ ] `linkPreviewEnabled: env.CHAT_LINK_PREVIEW_ENABLED` (default true)
- [ ] `linkPreviewTimeoutMs` (5000), `linkPreviewMaxBytes` (524288), `linkPreviewMaxRedirects` (3), `linkPreviewTtlDays` (7), `linkPreviewDenylist` (csv)
- [ ] Mirror all of the above in `ChatConfig` (`chat.service.ts`, ~line 61)

**DTOs** — `src/modules/chat/dto/chat.dto.ts`
- [ ] `ListStarredDto extends PaginationQueryDto` (`conversationId?`, `cursor?`)
- [ ] `PinMessageDto` (`messageId`)
- [ ] *(§5)* `UpdateConversationSettingsDto.wallpaper?`

**Events** — `events/chat.events.ts` + `constants/chat.constants.ts`
- [ ] `MessageStarredEvent` → `message.starred` (owner only)
- [ ] `MessageHiddenEvent` → `message.hidden` (owner only)
- [ ] `ConversationPinnedMessageEvent` → `conversation.pinned_message` (both)
- [ ] `MessagePreviewReadyEvent` → `message.preview` (both)
- [ ] Bridge all four in `listeners/chat-socket.listener.ts` (`fanOut`)

**Service / repos**
- [ ] `IChatService`: `star`, `unstar`, `listStarred`, `hideMessage`, `pinMessage`, `unpinMessage`
- [ ] `chat-view.mapper.ts`: `isStarred` (batch, one query per page), `linkPreview`, `ConversationView.pinned`, hidden-`lastMessage` fallback (§3.3b)
- [ ] `message.repository.ts`: hidden anti-join in `history()`
- [ ] `deleteMessage()`: clear the pin if pinned; drop star rows
- [ ] Link-preview processor on `QUEUE_NAMES.MEDIA_PROCESSING`

**Tests** — `chat.service.spec.ts`
- [ ] Star is idempotent; star limit enforced; starring a deleted/hidden message rejected
- [ ] Hide excludes from `history()` for the hider **and only the hider**
- [ ] Hiding the last message swaps that user's list preview, not the peer's
- [ ] Delete-for-everyone of a pinned message clears the banner for both
- [ ] `clearedAt` newer than the pinned message hides the banner for that user only
- [ ] **SSRF suite**: `127.0.0.1`, `10.0.0.1`, `169.254.169.254`, `[::1]`, a DNS-rebind redirect, an oversized body, and a non-HTML content-type are all rejected

---

## 8. What Part 4 (Flutter) will consume once this lands

All additive on the client too — Part 1–3 code keeps compiling.

- `ChatMessage` gains `isStarred` and `linkPreview` (+ `toCacheMap` / `fromCacheMap`, + the wire-contract test fixture).
- `Conversation` gains `pinned`.
- `ChatSocketEvent` union gains `message.starred`, `message.hidden`, `conversation.pinned_message`, `message.preview`.
- `ChatRepository` gains `star`, `unstar`, `listStarred`, `hideMessage`, `pinMessage`, `unpinMessage`.
- The message long-press menu then shows **Reply · Copy · Forward · Star · Edit · React · Delete for me · Delete for everyone · Pin · Report · Select · Info** — every one backed by a real endpoint, which is what "only show actions allowed by backend permissions" was always supposed to mean.
