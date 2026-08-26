# Post & Feed Feature — Design

Status: approved by user, pending spec review
Repos touched: `soulzaa-backend`, `soulzaa-mobile`

## 1. Overview

Users can create a post (multiple photos and/or a text description — at
least one of the two is required) from a new entry point on the Home
screen. Posts appear in a new **Feeds** tab in the bottom nav, ranked by
an engagement score (recency + likes + comments, decaying over time).
Posts support like/unlike, comments, and a minimal report mechanism for
moderation.

### Goals

- Create post: N photos (0–10) + optional description, at least one required.
- Feed: paginated, globally-visible, ranked by engagement score.
- Like/unlike a post, with a live count.
- Comment on a post (flat list, no nested replies).
- Report a post (minimal moderation hook — no moderator UI in this pass).
- Home screen's existing `+` icon opens Create Post, fully replacing its
  current "Start Audio Room" action (a separate entry point for Start
  Audio Room already exists elsewhere in the app and is unaffected).

### Non-goals (explicitly out of scope for this pass)

- Live-updating feed via WebSocket push (feed refresh is pull-to-refresh
  / re-fetch only; likes/comments still emit realtime *notifications* to
  the post author, matching the existing wallet/social notification
  pattern, but the feed list itself does not live-update for viewers).
- Comment-level reporting or comment replies/threads.
- A moderator-facing UI page for reviewing `PostReport` rows (the data
  model and API exist so this can be added later without a breaking
  change; building the review screen itself is a follow-up).
- Personalized/follow-based feed ranking (feed is global, not scoped by
  `Follow`/`Friendship`).
- Video posts (images only, matching `image_picker`'s existing
  multi-image capability already used in chat).

## 2. Data model — `prisma/schema/posts.prisma` (new file)

```prisma
model Post {
  id          String   @id @default(uuid()) @db.Uuid
  authorId    String   @db.Uuid
  description String?  @db.Text
  likeCount   Int      @default(0)
  commentCount Int     @default(0)
  score       Float    @default(0)
  status      PostStatus @default(PUBLISHED)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  deletedAt   DateTime?

  author      User          @relation(fields: [authorId], references: [id])
  media       PostMedia[]
  likes       PostLike[]
  comments    PostComment[]
  reports     PostReport[]

  @@index([status, score])
  @@index([authorId])
  @@map("posts")
}

enum PostStatus {
  PUBLISHED
  REMOVED
}

model PostMedia {
  id        String   @id @default(uuid()) @db.Uuid
  postId    String   @db.Uuid
  key       String   // S3 object key, from the existing presign/confirm flow
  order     Int      @default(0)
  createdAt DateTime @default(now())

  post      Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId])
  @@map("post_media")
}

model PostLike {
  id        String   @id @default(uuid()) @db.Uuid
  postId    String   @db.Uuid
  userId    String   @db.Uuid
  createdAt DateTime @default(now())

  post      Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, userId])
  @@map("post_likes")
}

model PostComment {
  id        String   @id @default(uuid()) @db.Uuid
  postId    String   @db.Uuid
  authorId  String   @db.Uuid
  body      String   @db.Text
  createdAt DateTime @default(now())
  deletedAt DateTime?

  post      Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId, createdAt])
  @@map("post_comments")
}

model PostReport {
  id         String   @id @default(uuid()) @db.Uuid
  postId     String   @db.Uuid
  reporterId String   @db.Uuid
  reason     String
  status     PostReportStatus @default(OPEN)
  createdAt  DateTime @default(now())

  post       Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, reporterId])
  @@map("post_reports")
}

enum PostReportStatus {
  OPEN
  REVIEWED
  DISMISSED
}
```

`User` (`users.prisma`) gets a back-relation `posts Post[]` added.

## 3. Backend

### 3.1 Storage

New category in `src/infra/storage/storage.constants.ts`:

```ts
POST_IMAGE: 'post-images',
```

Policy: `isImage: true`, `allowedMime: IMAGE_MIME`, `maxSizeBytes: 10 * MB`
(matches `ROOM_BACKGROUND`/`EVENT_BANNER`). Added to
`PUBLICLY_SERVABLE_PREFIXES` in `media-url.resolver.ts` — feed photos
need stable public CDN URLs, not short-lived presigned GETs, since a
feed page may render dozens of images per load.

No new upload endpoints — the existing generic `POST /storage/presign`
→ client `PUT` → `POST /storage/confirm` flow (`storage.controller.ts`)
is reused as-is, same as every other media type in this app.

### 3.2 Module — `src/modules/posts/` (fills in existing empty scaffolding)

```
posts/
  posts.module.ts
  constants/post.constants.ts        (score weights, decay params)
  controllers/post.controller.ts
  dto/
    create-post.dto.ts
    create-comment.dto.ts
    report-post.dto.ts
    feed-query.dto.ts
  services/
    post.service.ts                  (create, soft-delete)
    post-query.service.ts            (feed read, detail read — Paginated<T>)
    post-like.service.ts             (like/unlike, toggle semantics)
    post-comment.service.ts          (create/list/delete comment)
    post-report.service.ts           (create report)
    post-score.service.ts            (score formula, called by processor)
  events/post.events.ts              (PostLikedEvent, PostUnlikedEvent, PostCommentedEvent, PostCreatedEvent)
  listeners/
    post-score.listener.ts           (bumps likeCount/commentCount + score deltas)
    post-notification.listener.ts    (notifies post author via NotificationService/SocketManager)
  scheduler/post-score.scheduler.ts  (registers repeatable decay job via QueueService.schedule)
  processors/post-score.processor.ts (BullMQ processor: recomputes score for recent posts)
  entities/, interfaces/
  *.spec.ts colocated per file
```

Registered in `src/modules/index.ts`'s `DOMAIN_MODULES` (import +
add to array), following every other domain module.

### 3.3 API

All routes under `@Controller('posts')`, global `JwtAuthGuard` applies
automatically (no extra `@UseGuards` needed for self-service routes,
matching `TaskController`'s pattern). Wildcard `:id` routes placed last.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/posts` | self | `{ description?: string, mediaKeys?: string[] }` — validated: at least one of `description` (non-empty) or `mediaKeys` (≥1) required; `mediaKeys` max 10 |
| GET | `/posts/feed` | self | `?page&limit` → `Paginated<PostSummary>`, ordered by `score DESC` among `status = PUBLISHED` |
| GET | `/posts/:id` | self | Full post detail |
| DELETE | `/posts/:id` | self (author) or `@RequirePermissions('post.moderate')` | Soft-delete (`deletedAt`, `status = REMOVED`); `post.moderate` is a new permission string, added to `src/modules/authorization/constants/rbac-permissions.constants.ts` and granted to the moderator role matrix |
| POST | `/posts/:id/like` | self | Idempotent create (unique `[postId, userId]`); publishes `PostLikedEvent` |
| DELETE | `/posts/:id/like` | self | Idempotent remove; publishes `PostUnlikedEvent` |
| GET | `/posts/:id/comments` | self | `?page&limit` → `Paginated<Comment>` |
| POST | `/posts/:id/comments` | self | `{ body: string }`; publishes `PostCommentedEvent` |
| DELETE | `/posts/:id/comments/:commentId` | self (author) or `@RequirePermissions('post.moderate')` | Soft-delete |
| POST | `/posts/:id/report` | self | `{ reason: string }`; one report per user per post (`@@unique`) |

DTOs use `class-validator`/`class-transformer` + `@ApiProperty`, matching
`task.dto.ts`.

### 3.4 Events & realtime

Mirrors the wallet pattern exactly (`wallet-transaction.service.ts` →
`wallet-realtime.listener.ts`):

1. `post-like.service.ts`/`post-comment.service.ts` publish their event
   via the global `EVENT_BUS` **after** the DB write commits, never
   inside the transaction.
2. `post-score.listener.ts` subscribes and increments `Post.likeCount`/
   `commentCount` directly (`Prisma.increment`) plus a first-order score
   bump — cheap, synchronous-feeling counter updates without waiting for
   the decay job.
3. `post-notification.listener.ts` subscribes and sends "X liked your
   post" / "X commented on your post" via the existing
   `NotificationService` + `SocketManager.emitToUserEverywhere`, denormalizing
   actor name/avatar into the payload (same as
   `social-notification.listener.ts` does for follows).

No new socket namespace — reuses the existing notification channel.

### 3.5 Ranking algorithm

Score formula (Reddit/HN-style decaying hot score):

```
score = (likeCount * 2 + commentCount * 3) / (hoursSincePosted + 2) ^ 1.5
```

- **Incremental**: `post-score.listener.ts` updates `likeCount`/
  `commentCount` immediately on every like/comment event, so counts are
  always accurate.
- **Decay**: `hoursSincePosted` changes continuously, so `score` itself
  goes stale between events. A scheduled job re-applies the full formula
  to posts less than 7 days old, mirroring
  `video-room-ranking.scheduler.ts` exactly — `post-score.scheduler.ts`
  registers a repeatable BullMQ job via `QueueService.schedule` with a
  fixed `jobId` (idempotent across pod restarts/multi-instance
  deployment), on a `*/5 * * * *` cron pattern; `post-score.processor.ts`
  consumes it and recomputes `score` for the active window in a batch
  query. Posts older than 7 days stop being recomputed (their score
  naturally stays low and they age out of the top of the feed).
- `GET /posts/feed` is then a plain `ORDER BY score DESC` over the
  indexed column — no query-time aggregation.

### 3.6 Testing

Colocated `*.spec.ts` per service, hand-mocked Prisma objects
(`{ post: { findMany: jest.fn() } } as unknown as PrismaService`),
`describe('ServiceName.methodName', ...)` blocks, asserting both return
values and the exact `where`/`orderBy` clauses passed to Prisma —
matching `task-query.service.spec.ts`'s style. `post-score.service.spec.ts`
specifically asserts the score formula's output for known inputs.

## 4. Mobile (`soulzaa-mobile`)

### 4.1 Routing

- `RoutePaths.createPost` → new `CreatePostScreen` (pushed, not a shell branch).
- `RoutePaths.feeds` → new `FeedScreen`, added as a new
  `StatefulShellBranch` in `app_router.dart`'s existing
  `StatefulShellRoute.indexedStack`, and a new entry in `main_shell.dart`'s
  `_navItems` list (icon: `Icons.dynamic_feed_outlined` /
  `Icons.dynamic_feed_rounded`, matching the outlined/filled convention).
- `main_shell.dart`'s nav bar `ConstrainedBox(maxWidth: 334, minWidth: 320)`
  widens to fit 5 items instead of 4 (exact value determined during
  implementation by fitting actual rendered widths).

### 4.2 Home screen `+`

`home_screen.dart`'s existing `+` `GestureDetector` (`onTap: () =>
context.push(RoutePaths.audioRoomCreate)`) changes to `onTap: () =>
context.push(RoutePaths.createPost)`. `RoutePaths.audioRoomCreate` is
left in place for its existing separate entry point elsewhere; nothing
else references it through this button anymore.

### 4.3 `CreatePostScreen`

- Riverpod `Notifier`-based `CreatePostController` (state: staged
  photos, description text, submitting/progress), single screen (no
  wizard steps needed — simpler than `AgencyChallengeFormController`).
- Photo selection: `MediaPicker.pickImages()` (already used in
  `chat/presentation/controllers/media_picker.dart`), appended to
  staged list, capped at 10.
- New widget: photo grid preview (thumbnails in a `Wrap`/`GridView`,
  each with a remove-`×` overlay, plus an "add more" tile) — no existing
  widget does multi-photo staging, so this is new.
- One shared `TextField` for description (optional if ≥1 photo staged;
  required if 0 photos staged — client-side validation mirrors the
  backend's "at least one of the two" rule).
- Submit: for each staged photo, presign → `PUT` (bare `Dio()`, no auth
  header, matching `storage_remote_data_source.dart`) → confirm, run in
  parallel (`Future.wait`); collect resulting `key`s; then
  `POST /posts` with `{ description, mediaKeys }` as a plain JSON body
  via the existing `DioClient`. Progress indicator driven by
  `onSendProgress`, matching the chat upload's pattern.

### 4.4 `FeedScreen`

- `FeedController` (Riverpod `Notifier`), state shape
  `{ items, page, hasMore, isLoadingInitial, isLoadingMore, failure }`,
  identical to `RoomDiscoveryController`.
- `ScrollController` infinite-scroll (load more at 400px from bottom)
  + `RefreshIndicator` pull-to-refresh — both copied from
  `ExploreScreen`'s pattern.
- `PostCard` widget (new): author avatar/name, photo carousel (`PageView`)
  when `media` is non-empty, description text, like button (optimistic
  toggle — flips UI immediately, reconciles on response failure), comment
  count (tap opens comments sheet), overflow menu with "Report".
- Comments: `showModalBottomSheet` with a paginated comment list + input
  field, rather than a separate route — avoids adding another top-level
  screen for what is fundamentally a per-post drawer.

### 4.5 API/service layer

`PostsRemoteDataSource` (raw Dio calls) → `PostsRepositoryImpl`
(`ApiResult`-wrapped) → controllers, following the
`RoomsRemoteDataSource`/`RoomsRepositoryImpl` layering exactly. Endpoint
constants added to `lib/core/constants/api_endpoints.dart`.

## 5. Error handling

- Create post with 0 photos and empty description → 400 from backend
  DTO validation (`@ValidateIf`-based cross-field rule), mirrored by
  client-side validation so the error surfaces before an upload attempt.
- Photo upload failure mid-batch (one of N presign/PUT/confirm calls
  fails) → the whole post creation is aborted client-side (no partial
  posts with missing photos); staged photos remain so the user can retry
  without re-picking.
- Like/unlike double-tap race → idempotent by unique constraint /
  delete-if-exists, no error surfaced to the user either way.
- Report a post you already reported → `@@unique([postId, reporterId])`
  violation mapped to a friendly "already reported" response, not a raw
  500.

## 6. Assumptions carried from brainstorming

- Feed is global and public (not scoped by follows, state, or agency).
- No comment-level reporting, no nested comment replies.
- No moderator review UI for `PostReport` in this pass — data/API only.
