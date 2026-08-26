# Post & Feed Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the backend half of the Post & Feed feature — Prisma models, the `posts` NestJS module (create/delete, like/unlike, comments, report), a denormalized-score feed ranking, and event-driven notifications — so the mobile app has a working REST API to build against.

**Architecture:** A new `posts` domain module (filling in the existing empty `src/modules/posts/` scaffolding) following this repo's service-per-concern convention. Likes/comments publish events on the existing global `EVENT_BUS`; a `PostScoreListener` bumps denormalized counters+score immediately, and a `PostScoreScheduler` piggybacks on the existing `RANKING_PROCESSING` queue (via `QueueJobRegistry`, the seam `VideoRoomRankingJobsService` already uses — no new BullMQ processor) to re-apply time decay every 5 minutes. Photo uploads reuse the existing generic presign/confirm S3 flow — no new upload endpoints.

**Tech Stack:** NestJS, Prisma, PostgreSQL, BullMQ (via the shared `QueueJobRegistry` seam), Jest (hand-mocked Prisma, colocated `*.spec.ts`).

**Spec:** `docs/superpowers/specs/2026-08-25-post-feed-feature-design.md`

## Global Constraints

- Photos: 0–10 per post; at least one of `description` or `mediaKeys` is required.
- Score formula: `(likeCount*2 + commentCount*3) / (hoursSincePosted + 2)^1.5`, recomputed every 5 minutes for posts younger than 7 days.
- All new permission-gated logic must resolve permissions from the DB (`PermissionResolver.resolveUserPermissions`), never from the JWT's `permissions` claim (documented as stale-prone in `AuthenticatedUser`).
- Every new DTO uses `class-validator`/`class-transformer` + `@ApiProperty`/`@ApiPropertyOptional`, matching `src/modules/tasks/dto/task.dto.ts`.
- Every new service/listener/scheduler gets a colocated `*.spec.ts` using hand-mocked Prisma (`{ post: { findMany: jest.fn() } } as unknown as PrismaService`), no real DB in unit tests.

---

### Task 1: Prisma schema — Post, PostMedia, PostLike, PostComment, PostReport

**Files:**
- Create: `prisma/schema/posts.prisma`
- Modify: `prisma/schema/users.prisma` (add back-relation)
- Modify: `prisma/schema/notification.prisma` (add two `NotificationType` values)

**Interfaces:**
- Produces: `Post`, `PostMedia`, `PostLike`, `PostComment`, `PostReport`, `PostStatus`, `PostReportStatus` Prisma models/enums; `NotificationType.POST_LIKED`, `NotificationType.POST_COMMENTED`. Every later task's Prisma calls (`this.prisma.post.*`, `this.prisma.postMedia.*`, etc.) depend on these existing and being migrated.

- [ ] **Step 1: Write `prisma/schema/posts.prisma`**

```prisma
model Post {
  id           String     @id @default(uuid()) @db.Uuid
  authorId     String     @db.Uuid
  description  String?    @db.Text
  likeCount    Int        @default(0)
  commentCount Int        @default(0)
  score        Float      @default(0)
  status       PostStatus @default(PUBLISHED)
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
  deletedAt    DateTime?

  author   User          @relation(fields: [authorId], references: [id])
  media    PostMedia[]
  likes    PostLike[]
  comments PostComment[]
  reports  PostReport[]

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
  key       String
  order     Int      @default(0)
  createdAt DateTime @default(now())

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId])
  @@map("post_media")
}

model PostLike {
  id        String   @id @default(uuid()) @db.Uuid
  postId    String   @db.Uuid
  userId    String   @db.Uuid
  createdAt DateTime @default(now())

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, userId])
  @@map("post_likes")
}

model PostComment {
  id        String    @id @default(uuid()) @db.Uuid
  postId    String    @db.Uuid
  authorId  String    @db.Uuid
  body      String    @db.Text
  createdAt DateTime  @default(now())
  deletedAt DateTime?

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([postId, createdAt])
  @@map("post_comments")
}

model PostReport {
  id         String           @id @default(uuid()) @db.Uuid
  postId     String           @db.Uuid
  reporterId String           @db.Uuid
  reason     String
  status     PostReportStatus @default(OPEN)
  createdAt  DateTime         @default(now())

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@unique([postId, reporterId])
  @@map("post_reports")
}

enum PostReportStatus {
  OPEN
  REVIEWED
  DISMISSED
}
```

- [ ] **Step 2: Add the back-relation to `User` in `prisma/schema/users.prisma`**

Find the `model User { ... }` block and add one line inside it (near the other relation fields, e.g. next to `roles` or similar list relations):

```prisma
  posts Post[]
```

- [ ] **Step 3: Add two notification types**

In `prisma/schema/notification.prisma`, inside `enum NotificationType { ... }`, add (anywhere in the list, e.g. after `MENTION`):

```prisma
  POST_LIKED
  POST_COMMENTED
```

- [ ] **Step 4: Generate and run the migration**

Run: `npx prisma format && npx prisma validate`
Expected: no errors.

Run: `npx prisma migrate dev --name add_posts_feature`

Per project memory: if this prompts to reset the dev database due to pre-existing drift, **do NOT confirm that prompt** — stop and ask the user how to proceed instead of accepting a full dev-DB reset.

- [ ] **Step 5: Regenerate the Prisma client**

Run: `npx prisma generate`
Expected: completes without error; `@prisma/client` now exports `PostStatus`, `PostReportStatus`, and the new model delegates.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema/posts.prisma prisma/schema/users.prisma prisma/schema/notification.prisma prisma/migrations
git commit -m "feat(posts): add Post/PostMedia/PostLike/PostComment/PostReport schema"
```

---

### Task 2: Storage — POST_IMAGE category

**Files:**
- Modify: `src/infra/storage/storage.constants.ts`
- Modify: `src/infra/storage/media-url.resolver.ts`
- Test: `src/infra/storage/media-url.resolver.spec.ts` (create if it doesn't already exist; if it does, add a case to it)

**Interfaces:**
- Produces: `STORAGE_CATEGORIES.POST_IMAGE` (value `'post-images'`), usable by the mobile client's presign/confirm calls and by `PostService`'s key-ownership check in Task 5.

- [ ] **Step 1: Add the category + policy**

In `src/infra/storage/storage.constants.ts`, add to `STORAGE_CATEGORIES`:

```ts
  POST_IMAGE: 'post-images',
```

Add to `STORAGE_POLICIES` (same shape as `ROOM_BACKGROUND`):

```ts
  [STORAGE_CATEGORIES.POST_IMAGE]: {
    prefix: STORAGE_CATEGORIES.POST_IMAGE,
    isImage: true,
    allowedMime: IMAGE_MIME,
    maxSizeBytes: 10 * MB,
  },
```

- [ ] **Step 2: Make post images publicly servable**

In `src/infra/storage/media-url.resolver.ts`, add to `PUBLICLY_SERVABLE_PREFIXES`:

```ts
  STORAGE_CATEGORIES.POST_IMAGE,
```

- [ ] **Step 3: Write a test asserting the category resolves publicly**

Check whether `src/infra/storage/media-url.resolver.spec.ts` exists (`ls src/infra/storage/*.spec.ts`). If it exists, add this case inside its existing `describe` block; if not, create it with this minimal shape (mock `ConfigService`/`S3Service` following whatever pattern the existing spec file uses for `storage.constants.spec.ts` or `upload.service.spec.ts` in the same directory — read one of those first for the exact mock shape before writing this file).

```ts
it('resolves a POST_IMAGE key to a stable public URL', async () => {
  const resolver = new MediaUrlResolver(
    { get: () => ({ mediaPublicBaseUrl: 'https://cdn.example.com' }) } as any,
    { getPresignedDownloadUrl: jest.fn() } as any,
  );
  const url = await resolver.resolve('post-images/user-1/photo.jpg');
  expect(url).toBe('https://cdn.example.com/post-images/user-1/photo.jpg');
});
```

- [ ] **Step 4: Run the test**

Run: `npx jest src/infra/storage/media-url.resolver.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infra/storage/storage.constants.ts src/infra/storage/media-url.resolver.ts src/infra/storage/media-url.resolver.spec.ts
git commit -m "feat(posts): add POST_IMAGE storage category"
```

---

### Task 3: RBAC — `post.moderate` permission

**Files:**
- Modify: `src/modules/authorization/constants/rbac-permissions.constants.ts`

**Interfaces:**
- Produces: permission code `'post.moderate'`, granted to `MODERATOR` and `ADMIN`. Task 5's `PostService.deletePost` and Task 8's `PostCommentService.deleteComment` check for this via `PermissionResolver.resolveUserPermissions(actorId).has('post.moderate')`.

- [ ] **Step 1: Add a `POST` permission category**

In `PERMISSION_CATEGORIES`, add `'POST'` to the array (anywhere, e.g. after `'TASK'`).

- [ ] **Step 2: Add the permission definition**

In `DEFAULT_PERMISSIONS`, add:

```ts
  {
    code: 'post.moderate',
    module: 'posts',
    action: 'moderate',
    category: 'POST',
    displayName: 'Moderate Posts',
    description: 'Delete any user post or comment',
  },
```

- [ ] **Step 2: Grant it to MODERATOR and ADMIN**

In `DEFAULT_ROLE_PERMISSIONS.MODERATOR`, add `'post.moderate'` to the array (alongside `'user.ban'`, `'room.update'`, etc.).

In `DEFAULT_ROLE_PERMISSIONS.ADMIN`, add `'post.moderate'` to the array (alongside `'task.manage'`, `'moderation.action.approve'`, etc.).

- [ ] **Step 3: Run the existing RBAC test suites and fix any failures**

Run: `npx jest src/modules/authorization/constants --silent`

This file is large (1700+ lines) and encodes specific PRD business rules per role. If a test fails because of this addition, read the failing assertion, understand which rule it's checking, and adjust (most likely: some tests assert an exact permission *count* or *exhaustive list* per role — update the expected list/count to include `post.moderate` rather than removing the permission).

Expected once fixed: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/modules/authorization/constants/rbac-permissions.constants.ts
git commit -m "feat(posts): add post.moderate permission for Moderator/Admin"
```

---

### Task 4: Shared contracts — DTOs, events, response interfaces

**Files:**
- Create: `src/modules/posts/dto/create-post.dto.ts`
- Create: `src/modules/posts/dto/create-comment.dto.ts`
- Create: `src/modules/posts/dto/report-post.dto.ts`
- Create: `src/modules/posts/dto/feed-query.dto.ts`
- Create: `src/modules/posts/events/post.events.ts`
- Create: `src/modules/posts/interfaces/post-summary.interface.ts`
- Test: `src/modules/posts/dto/create-post.dto.spec.ts`

**Interfaces:**
- Produces: `CreatePostDto`, `CreateCommentDto`, `ReportPostDto`, `FeedQueryDto`; `POST_EVENTS`, `PostCreatedEvent`, `PostLikedEvent`, `PostUnlikedEvent`, `PostCommentedEvent`; `PostSummary`, `PostSummaryAuthor`, `PostCommentView`. Every later service/controller task imports from these files.

- [ ] **Step 1: `create-post.dto.ts`**

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePostDto {
  @ApiPropertyOptional({ description: 'Post caption/description' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Confirmed S3 object keys for staged photos, in display order',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  mediaKeys?: string[];
}
```

- [ ] **Step 2: `create-comment.dto.ts`**

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ description: 'Comment text' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  body!: string;
}
```

- [ ] **Step 3: `report-post.dto.ts`**

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class ReportPostDto {
  @ApiProperty({ description: 'Reason for reporting this post' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
```

- [ ] **Step 4: `feed-query.dto.ts`**

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class FeedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
```

- [ ] **Step 5: `events/post.events.ts`**

```ts
import { DomainEvent } from 'src/common/events';

export const POST_EVENTS = {
  CREATED: 'post.created',
  LIKED: 'post.liked',
  UNLIKED: 'post.unliked',
  COMMENTED: 'post.commented',
} as const;

export class PostCreatedEvent extends DomainEvent<{ postId: string; authorId: string }> {
  readonly name = POST_EVENTS.CREATED;
}

export class PostLikedEvent extends DomainEvent<{ postId: string; userId: string }> {
  readonly name = POST_EVENTS.LIKED;
}

export class PostUnlikedEvent extends DomainEvent<{ postId: string; userId: string }> {
  readonly name = POST_EVENTS.UNLIKED;
}

export class PostCommentedEvent extends DomainEvent<{
  postId: string;
  authorId: string;
  commentId: string;
}> {
  readonly name = POST_EVENTS.COMMENTED;
}
```

- [ ] **Step 6: `interfaces/post-summary.interface.ts`**

```ts
export interface PostSummaryAuthor {
  id: string;
  username: string;
  fullName: string | null;
  avatarUrl: string | null;
}

export interface PostSummary {
  id: string;
  description: string | null;
  photoUrls: string[];
  likeCount: number;
  commentCount: number;
  likedByMe: boolean;
  createdAt: Date;
  author: PostSummaryAuthor;
}

export interface PostCommentView {
  id: string;
  postId: string;
  body: string;
  createdAt: Date;
  author: PostSummaryAuthor;
}
```

- [ ] **Step 7: Write `create-post.dto.spec.ts`**

```ts
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreatePostDto } from './create-post.dto';

describe('CreatePostDto', () => {
  it('accepts a description-only post', async () => {
    const dto = plainToInstance(CreatePostDto, { description: 'Hello world' });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('accepts a photos-only post', async () => {
    const dto = plainToInstance(CreatePostDto, { mediaKeys: ['post-images/u1/a.jpg'] });
    expect(await validate(dto)).toHaveLength(0);
  });

  it('rejects more than 10 media keys', async () => {
    const dto = plainToInstance(CreatePostDto, {
      mediaKeys: Array.from({ length: 11 }, (_, i) => `post-images/u1/${i}.jpg`),
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
```

- [ ] **Step 8: Run the test**

Run: `npx jest src/modules/posts/dto/create-post.dto.spec.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/posts/dto src/modules/posts/events src/modules/posts/interfaces
git commit -m "feat(posts): add DTOs, domain events, and response interfaces"
```

---

### Task 5: `post.service.ts` — create & delete

**Files:**
- Create: `src/modules/posts/services/post.service.ts`
- Test: `src/modules/posts/services/post.service.spec.ts`

**Interfaces:**
- Consumes: `POST_EVENTS`, `PostCreatedEvent` (Task 4); `EVENT_BUS`/`IEventBus` (`src/common/events`); `PermissionResolver` (`src/modules/authorization/services/permission-resolver.service`); `STORAGE_CATEGORIES.POST_IMAGE` (Task 2).
- Produces: `PostService.createPost(input: CreatePostInput): Promise<Post>`, `PostService.deletePost(postId: string, actorId: string): Promise<void>`. Task 14's controller calls both.

- [ ] **Step 1: Write the failing test**

```ts
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { PostService } from './post.service';

describe('PostService', () => {
  function build() {
    const prisma = {
      post: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const bus = { publish: jest.fn() };
    const permissions = { resolveUserPermissions: jest.fn() };
    const service = new PostService(prisma as any, bus as any, permissions as any);
    return { service, prisma, bus, permissions };
  }

  describe('createPost', () => {
    it('rejects a post with no description and no photos', async () => {
      const { service } = build();
      await expect(
        service.createPost({ authorId: 'u1', description: undefined, mediaKeys: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a photo key that does not belong to the author', async () => {
      const { service } = build();
      await expect(
        service.createPost({ authorId: 'u1', mediaKeys: ['post-images/someone-else/a.jpg'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a post and publishes PostCreatedEvent', async () => {
      const { service, prisma, bus } = build();
      prisma.post.create.mockResolvedValue({ id: 'p1', authorId: 'u1' });

      const post = await service.createPost({
        authorId: 'u1',
        description: 'hi',
        mediaKeys: ['post-images/u1/a.jpg'],
      });

      expect(post).toEqual({ id: 'p1', authorId: 'u1' });
      expect(prisma.post.create).toHaveBeenCalledWith({
        data: {
          authorId: 'u1',
          description: 'hi',
          media: { create: [{ key: 'post-images/u1/a.jpg', order: 0 }] },
        },
      });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', authorId: 'u1' } }),
      );
    });
  });

  describe('deletePost', () => {
    it('throws NotFoundException for a missing post', async () => {
      const { service, prisma } = build();
      prisma.post.findUnique.mockResolvedValue(null);
      await expect(service.deletePost('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets the author delete their own post without a permission check', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });

      await service.deletePost('p1', 'u1');

      expect(permissions.resolveUserPermissions).not.toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({ status: PostStatus.REMOVED }),
      });
    });

    it('rejects a non-author without post.moderate', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set());

      await expect(service.deletePost('p1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a moderator delete someone else’s post', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set(['post.moderate']));

      await service.deletePost('p1', 'mod1');

      expect(prisma.post.update).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post.service.spec.ts`
Expected: FAIL — `Cannot find module './post.service'`.

- [ ] **Step 3: Write `post.service.ts`**

```ts
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Post, PostStatus } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { STORAGE_CATEGORIES } from 'src/infra/storage/storage.constants';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import { PostCreatedEvent } from '../events/post.events';

export interface CreatePostInput {
  authorId: string;
  description?: string;
  mediaKeys?: string[];
}

@Injectable()
export class PostService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly permissions: PermissionResolver,
  ) {}

  async createPost(input: CreatePostInput): Promise<Post> {
    const description = input.description?.trim() || undefined;
    const mediaKeys = input.mediaKeys ?? [];
    if (!description && mediaKeys.length === 0) {
      throw new BadRequestException('A post needs a description or at least one photo.');
    }
    this.assertOwnedKeys(input.authorId, mediaKeys);

    const post = await this.prisma.post.create({
      data: {
        authorId: input.authorId,
        description: description ?? null,
        media: { create: mediaKeys.map((key, order) => ({ key, order })) },
      },
    });

    await this.bus.publish(new PostCreatedEvent({ postId: post.id, authorId: post.authorId }));
    return post;
  }

  async deletePost(postId: string, actorId: string): Promise<void> {
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.deletedAt) throw new NotFoundException('Post not found');

    if (post.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!granted.has('post.moderate')) {
        throw new ForbiddenException('Not allowed to delete this post');
      }
    }

    await this.prisma.post.update({
      where: { id: postId },
      data: { status: PostStatus.REMOVED, deletedAt: new Date() },
    });
  }

  /** Each staged photo's key must have been minted for this user by the storage presign flow. */
  private assertOwnedKeys(authorId: string, mediaKeys: string[]): void {
    const prefix = `${STORAGE_CATEGORIES.POST_IMAGE}/${authorId}/`;
    for (const key of mediaKeys) {
      if (!key.startsWith(prefix)) {
        throw new BadRequestException('One of the provided photos does not belong to you.');
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post.service.spec.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post.service.ts src/modules/posts/services/post.service.spec.ts
git commit -m "feat(posts): add PostService create/delete"
```

---

### Task 6: `post-query.service.ts` — feed & detail reads

**Files:**
- Create: `src/modules/posts/services/post-query.service.ts`
- Test: `src/modules/posts/services/post-query.service.spec.ts`

**Interfaces:**
- Consumes: `PostSummary`/`PostSummaryAuthor` (Task 4); `MediaUrlResolver` (`src/infra/storage/media-url.resolver`); `PROFILE_SERVICE`/`IProfileService` (`src/modules/users/interfaces/profile.interface`); `normalizePagination`/`buildPaginated` (`src/common/utils/pagination.util`).
- Produces: `PostQueryService.getFeed(viewerId, page?, limit?): Promise<Paginated<PostSummary>>`, `PostQueryService.getById(postId, viewerId): Promise<PostSummary | null>`. Task 14's controller calls both; Task 5's `createPost` response is shaped by calling `getById` from the controller.

- [ ] **Step 1: Write the failing test**

```ts
import { PostStatus, Prisma } from '@prisma/client';
import { PostQueryService } from './post-query.service';

describe('PostQueryService', () => {
  function build() {
    const prisma = { post: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn() } };
    const media = { resolve: jest.fn(async (key: string) => `https://cdn/${key}`) };
    const profile = { getCards: jest.fn(async () => []) };
    const service = new PostQueryService(prisma as any, media as any, profile as any);
    return { service, prisma, media, profile };
  }

  const row = (overrides: Partial<any> = {}) => ({
    id: 'p1',
    authorId: 'u1',
    description: 'hi',
    likeCount: 2,
    commentCount: 1,
    createdAt: new Date('2026-08-25T00:00:00Z'),
    media: [{ key: 'post-images/u1/a.jpg', order: 0 }],
    likes: [],
    ...overrides,
  });

  it('marks a post as liked when the viewer has a like row', async () => {
    const { service, prisma, profile } = build();
    prisma.post.findMany.mockResolvedValue([row({ likes: [{ userId: 'viewer1' }] })]);
    prisma.post.count.mockResolvedValue(1);
    profile.getCards.mockResolvedValue([
      { id: 'u1', username: 'alice', fullName: 'Alice', avatarUrl: 'https://cdn/avatar.jpg' },
    ]);

    const feed = await service.getFeed('viewer1', 1, 20);

    expect(feed.items[0].likedByMe).toBe(true);
    expect(feed.items[0].author).toEqual({
      id: 'u1',
      username: 'alice',
      fullName: 'Alice',
      avatarUrl: 'https://cdn/avatar.jpg',
    });
    expect(feed.items[0].photoUrls).toEqual(['https://cdn/post-images/u1/a.jpg']);
  });

  it('queries only PUBLISHED, non-deleted posts ordered by score', async () => {
    const { service, prisma } = build();
    prisma.post.findMany.mockResolvedValue([]);
    prisma.post.count.mockResolvedValue(0);

    await service.getFeed('viewer1', 1, 20);

    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: PostStatus.PUBLISHED, deletedAt: null },
        orderBy: { score: 'desc' },
      }),
    );
  });

  it('returns null from getById when the post is missing', async () => {
    const { service, prisma } = build();
    prisma.post.findFirst.mockResolvedValue(null);
    expect(await service.getById('missing', 'viewer1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post-query.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-query.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PostStatus } from '@prisma/client';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { PROFILE_SERVICE, type IProfileService } from 'src/modules/users/interfaces/profile.interface';
import type { PostSummary } from '../interfaces/post-summary.interface';

const POST_INCLUDE = (viewerId: string) =>
  Prisma.validator<Prisma.PostInclude>()({
    media: { orderBy: { order: 'asc' } },
    likes: { where: { userId: viewerId }, select: { userId: true } },
  });

type PostRow = Prisma.PostGetPayload<{ include: ReturnType<typeof POST_INCLUDE> }>;

@Injectable()
export class PostQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaUrlResolver,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
  ) {}

  async getFeed(viewerId: string, page?: number, limit?: number): Promise<Paginated<PostSummary>> {
    const { page: p, limit: l, skip } = normalizePagination({ page, limit });
    const where = { status: PostStatus.PUBLISHED, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.post.findMany({
        where,
        orderBy: { score: 'desc' },
        skip,
        take: l,
        include: POST_INCLUDE(viewerId),
      }),
      this.prisma.post.count({ where }),
    ]);
    return buildPaginated(await this.toSummaries(rows), total, p, l);
  }

  async getById(postId: string, viewerId: string): Promise<PostSummary | null> {
    const row = await this.prisma.post.findFirst({
      where: { id: postId, deletedAt: null },
      include: POST_INCLUDE(viewerId),
    });
    if (!row) return null;
    const [summary] = await this.toSummaries([row]);
    return summary;
  }

  private async toSummaries(rows: PostRow[]): Promise<PostSummary[]> {
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const cards = await this.profile.getCards(authorIds);
    const cardById = new Map(cards.map((c) => [c.id, c]));

    return Promise.all(
      rows.map(async (row) => {
        const photoUrls = (await Promise.all(row.media.map((m) => this.media.resolve(m.key)))).filter(
          (u): u is string => !!u,
        );
        const card = cardById.get(row.authorId);
        return {
          id: row.id,
          description: row.description,
          photoUrls,
          likeCount: row.likeCount,
          commentCount: row.commentCount,
          likedByMe: row.likes.length > 0,
          createdAt: row.createdAt,
          author: {
            id: row.authorId,
            username: card?.username ?? 'user',
            fullName: card?.fullName ?? null,
            avatarUrl: card?.avatarUrl ?? null,
          },
        };
      }),
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post-query.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post-query.service.ts src/modules/posts/services/post-query.service.spec.ts
git commit -m "feat(posts): add PostQueryService feed/detail reads"
```

---

### Task 7: `post-like.service.ts`

**Files:**
- Create: `src/modules/posts/services/post-like.service.ts`
- Test: `src/modules/posts/services/post-like.service.spec.ts`

**Interfaces:**
- Consumes: `PostLikedEvent`, `PostUnlikedEvent`, `POST_EVENTS` (Task 4); `EVENT_BUS`.
- Produces: `PostLikeService.like(postId, userId): Promise<void>`, `PostLikeService.unlike(postId, userId): Promise<void>`. Task 14's controller calls both; Task 11's listener subscribes to the events these publish.

- [ ] **Step 1: Write the failing test**

```ts
import { Prisma } from '@prisma/client';
import { PostLikeService } from './post-like.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

describe('PostLikeService', () => {
  function build() {
    const prisma = { postLike: { create: jest.fn(), deleteMany: jest.fn() } };
    const bus = { publish: jest.fn() };
    const service = new PostLikeService(prisma as any, bus as any);
    return { service, prisma, bus };
  }

  describe('like', () => {
    it('creates the like row and publishes PostLikedEvent', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.create.mockResolvedValue({});

      await service.like('p1', 'u1');

      expect(prisma.postLike.create).toHaveBeenCalledWith({ data: { postId: 'p1', userId: 'u1' } });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', userId: 'u1' } }),
      );
    });

    it('is idempotent — a duplicate like does not publish again', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.create.mockRejectedValue(uniqueViolation());

      await service.like('p1', 'u1');

      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  describe('unlike', () => {
    it('publishes PostUnlikedEvent only when a row was actually deleted', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.deleteMany.mockResolvedValue({ count: 1 });

      await service.unlike('p1', 'u1');

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', userId: 'u1' } }),
      );
    });

    it('does nothing when there was no like to remove', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.deleteMany.mockResolvedValue({ count: 0 });

      await service.unlike('p1', 'u1');

      expect(bus.publish).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post-like.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-like.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PostLikedEvent, PostUnlikedEvent } from '../events/post.events';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PostLikeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
  ) {}

  async like(postId: string, userId: string): Promise<void> {
    try {
      await this.prisma.postLike.create({ data: { postId, userId } });
    } catch (err) {
      if (isUniqueConstraintError(err)) return;
      throw err;
    }
    await this.bus.publish(new PostLikedEvent({ postId, userId }));
  }

  async unlike(postId: string, userId: string): Promise<void> {
    const deleted = await this.prisma.postLike.deleteMany({ where: { postId, userId } });
    if (deleted.count > 0) {
      await this.bus.publish(new PostUnlikedEvent({ postId, userId }));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post-like.service.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post-like.service.ts src/modules/posts/services/post-like.service.spec.ts
git commit -m "feat(posts): add PostLikeService"
```

---

### Task 8: `post-comment.service.ts`

**Files:**
- Create: `src/modules/posts/services/post-comment.service.ts`
- Test: `src/modules/posts/services/post-comment.service.spec.ts`

**Interfaces:**
- Consumes: `PostCommentedEvent`, `POST_EVENTS` (Task 4); `PostCommentView` (Task 4); `PROFILE_SERVICE`/`IProfileService`; `PermissionResolver`.
- Produces: `PostCommentService.addComment(postId, authorId, body): Promise<PostComment>`, `.listComments(postId, page?, limit?): Promise<Paginated<PostCommentView>>`, `.deleteComment(commentId, actorId): Promise<void>`. Task 14's controller calls all three.

- [ ] **Step 1: Write the failing test**

```ts
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostCommentService } from './post-comment.service';

describe('PostCommentService', () => {
  function build() {
    const prisma = {
      post: { findFirst: jest.fn() },
      postComment: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const bus = { publish: jest.fn() };
    const profile = { getCards: jest.fn(async () => []) };
    const permissions = { resolveUserPermissions: jest.fn() };
    const service = new PostCommentService(prisma as any, bus as any, profile as any, permissions as any);
    return { service, prisma, bus, profile, permissions };
  }

  describe('addComment', () => {
    it('throws NotFoundException for a missing post', async () => {
      const { service, prisma } = build();
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.addComment('p1', 'u1', 'hi')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates the comment and publishes PostCommentedEvent', async () => {
      const { service, prisma, bus } = build();
      prisma.post.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.postComment.create.mockResolvedValue({ id: 'c1', postId: 'p1', authorId: 'u1' });

      const comment = await service.addComment('p1', 'u1', 'hi');

      expect(comment.id).toBe('c1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', authorId: 'u1', commentId: 'c1' } }),
      );
    });
  });

  describe('listComments', () => {
    it('denormalizes each comment’s author card', async () => {
      const { service, prisma, profile } = build();
      prisma.postComment.findMany.mockResolvedValue([
        { id: 'c1', postId: 'p1', authorId: 'u1', body: 'hi', createdAt: new Date() },
      ]);
      prisma.postComment.count.mockResolvedValue(1);
      profile.getCards.mockResolvedValue([
        { id: 'u1', username: 'alice', fullName: 'Alice', avatarUrl: null },
      ]);

      const page = await service.listComments('p1', 1, 20);

      expect(page.items[0].author.username).toBe('alice');
    });
  });

  describe('deleteComment', () => {
    it('rejects a non-author without post.moderate', async () => {
      const { service, prisma, permissions } = build();
      prisma.postComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set());

      await expect(service.deleteComment('c1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the author delete their own comment', async () => {
      const { service, prisma, permissions } = build();
      prisma.postComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'u1', deletedAt: null });

      await service.deleteComment('c1', 'u1');

      expect(permissions.resolveUserPermissions).not.toHaveBeenCalled();
      expect(prisma.postComment.update).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post-comment.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-comment.service.ts`**

```ts
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PostComment } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PermissionResolver } from 'src/modules/authorization/services/permission-resolver.service';
import { PROFILE_SERVICE, type IProfileService } from 'src/modules/users/interfaces/profile.interface';
import { PostCommentedEvent } from '../events/post.events';
import type { PostCommentView } from '../interfaces/post-summary.interface';

@Injectable()
export class PostCommentService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly permissions: PermissionResolver,
  ) {}

  async addComment(postId: string, authorId: string, body: string): Promise<PostComment> {
    const post = await this.prisma.post.findFirst({ where: { id: postId, deletedAt: null } });
    if (!post) throw new NotFoundException('Post not found');

    const comment = await this.prisma.postComment.create({ data: { postId, authorId, body } });
    await this.bus.publish(new PostCommentedEvent({ postId, authorId, commentId: comment.id }));
    return comment;
  }

  async listComments(postId: string, page?: number, limit?: number): Promise<Paginated<PostCommentView>> {
    const { page: p, limit: l, skip } = normalizePagination({ page, limit });
    const where = { postId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.prisma.postComment.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take: l }),
      this.prisma.postComment.count({ where }),
    ]);

    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const cards = await this.profile.getCards(authorIds);
    const cardById = new Map(cards.map((c) => [c.id, c]));

    const items: PostCommentView[] = rows.map((r) => {
      const card = cardById.get(r.authorId);
      return {
        id: r.id,
        postId: r.postId,
        body: r.body,
        createdAt: r.createdAt,
        author: {
          id: r.authorId,
          username: card?.username ?? 'user',
          fullName: card?.fullName ?? null,
          avatarUrl: card?.avatarUrl ?? null,
        },
      };
    });

    return buildPaginated(items, total, p, l);
  }

  async deleteComment(commentId: string, actorId: string): Promise<void> {
    const comment = await this.prisma.postComment.findUnique({ where: { id: commentId } });
    if (!comment || comment.deletedAt) throw new NotFoundException('Comment not found');

    if (comment.authorId !== actorId) {
      const granted = await this.permissions.resolveUserPermissions(actorId);
      if (!granted.has('post.moderate')) {
        throw new ForbiddenException('Not allowed to delete this comment');
      }
    }

    await this.prisma.postComment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post-comment.service.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post-comment.service.ts src/modules/posts/services/post-comment.service.spec.ts
git commit -m "feat(posts): add PostCommentService"
```

---

### Task 9: `post-report.service.ts`

**Files:**
- Create: `src/modules/posts/services/post-report.service.ts`
- Test: `src/modules/posts/services/post-report.service.spec.ts`

**Interfaces:**
- Produces: `PostReportService.report(postId, reporterId, reason): Promise<PostReport>`. Task 14's controller calls it.

- [ ] **Step 1: Write the failing test**

```ts
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PostReportService } from './post-report.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

describe('PostReportService', () => {
  it('creates a report row', async () => {
    const prisma = { postReport: { create: jest.fn().mockResolvedValue({ id: 'r1' }) } };
    const service = new PostReportService(prisma as any);

    const report = await service.report('p1', 'u1', 'spam');

    expect(report).toEqual({ id: 'r1' });
    expect(prisma.postReport.create).toHaveBeenCalledWith({
      data: { postId: 'p1', reporterId: 'u1', reason: 'spam' },
    });
  });

  it('maps a duplicate report to a friendly ConflictException', async () => {
    const prisma = { postReport: { create: jest.fn().mockRejectedValue(uniqueViolation()) } };
    const service = new PostReportService(prisma as any);

    await expect(service.report('p1', 'u1', 'spam')).rejects.toBeInstanceOf(ConflictException);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post-report.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-report.service.ts`**

```ts
import { ConflictException, Injectable } from '@nestjs/common';
import { PostReport, Prisma } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

@Injectable()
export class PostReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(postId: string, reporterId: string, reason: string): Promise<PostReport> {
    try {
      return await this.prisma.postReport.create({ data: { postId, reporterId, reason } });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        throw new ConflictException('You already reported this post.');
      }
      throw err;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post-report.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post-report.service.ts src/modules/posts/services/post-report.service.spec.ts
git commit -m "feat(posts): add PostReportService"
```

---

### Task 10: `post-score.service.ts` — ranking formula

**Files:**
- Create: `src/modules/posts/services/post-score.service.ts`
- Test: `src/modules/posts/services/post-score.service.spec.ts`

**Interfaces:**
- Produces: `PostScoreService.computeScore(likeCount, commentCount, createdAt, now?): number`, `.recomputeActivePosts(now?): Promise<{ recomputed: number }>`. Task 11's listener and Task 13's scheduler both call these.

- [ ] **Step 1: Write the failing test**

```ts
import { PostStatus } from '@prisma/client';
import { PostScoreService } from './post-score.service';

describe('PostScoreService', () => {
  describe('computeScore', () => {
    it('is zero for a brand-new post with no engagement', () => {
      const service = new PostScoreService({} as any);
      const now = new Date('2026-08-25T12:00:00Z');
      expect(service.computeScore(0, 0, now, now)).toBe(0);
    });

    it('increases with likes and comments', () => {
      const service = new PostScoreService({} as any);
      const now = new Date('2026-08-25T12:00:00Z');
      const createdAt = new Date('2026-08-25T10:00:00Z');
      const noEngagement = service.computeScore(0, 0, createdAt, now);
      const withEngagement = service.computeScore(5, 2, createdAt, now);
      expect(withEngagement).toBeGreaterThan(noEngagement);
    });

    it('decays as the post ages, holding engagement constant', () => {
      const service = new PostScoreService({} as any);
      const createdAt = new Date('2026-08-25T00:00:00Z');
      const scoreAt1h = service.computeScore(10, 5, createdAt, new Date('2026-08-25T01:00:00Z'));
      const scoreAt10h = service.computeScore(10, 5, createdAt, new Date('2026-08-25T10:00:00Z'));
      expect(scoreAt10h).toBeLessThan(scoreAt1h);
    });
  });

  describe('recomputeActivePosts', () => {
    it('recomputes score only for PUBLISHED posts created within the last 7 days', async () => {
      const prisma = {
        post: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'p1', likeCount: 3, commentCount: 1, createdAt: new Date('2026-08-24T00:00:00Z') },
          ]),
          update: jest.fn(),
        },
      };
      const service = new PostScoreService(prisma as any);

      const result = await service.recomputeActivePosts(new Date('2026-08-25T00:00:00Z'));

      expect(result).toEqual({ recomputed: 1 });
      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: PostStatus.PUBLISHED, deletedAt: null }),
        }),
      );
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { score: expect.any(Number) },
      });
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/services/post-score.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-score.service.ts`**

```ts
import { Injectable } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

const LIKE_WEIGHT = 2;
const COMMENT_WEIGHT = 3;
const GRAVITY = 1.5;
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class PostScoreService {
  constructor(private readonly prisma: PrismaService) {}

  computeScore(likeCount: number, commentCount: number, createdAt: Date, now: Date = new Date()): number {
    const hoursSincePosted = Math.max(0, (now.getTime() - createdAt.getTime()) / 3_600_000);
    const weight = likeCount * LIKE_WEIGHT + commentCount * COMMENT_WEIGHT;
    return weight / Math.pow(hoursSincePosted + 2, GRAVITY);
  }

  async recomputeActivePosts(now: Date = new Date()): Promise<{ recomputed: number }> {
    const since = new Date(now.getTime() - ACTIVE_WINDOW_MS);
    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.PUBLISHED, deletedAt: null, createdAt: { gte: since } },
      select: { id: true, likeCount: true, commentCount: true, createdAt: true },
    });

    for (const post of posts) {
      const score = this.computeScore(post.likeCount, post.commentCount, post.createdAt, now);
      await this.prisma.post.update({ where: { id: post.id }, data: { score } });
    }

    return { recomputed: posts.length };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/services/post-score.service.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/services/post-score.service.ts src/modules/posts/services/post-score.service.spec.ts
git commit -m "feat(posts): add PostScoreService ranking formula"
```

---

### Task 11: `post-score.listener.ts` — incremental counter/score bumps

**Files:**
- Create: `src/modules/posts/listeners/post-score.listener.ts`
- Test: `src/modules/posts/listeners/post-score.listener.spec.ts`

**Interfaces:**
- Consumes: `POST_EVENTS`, `PostLikedEvent`, `PostUnlikedEvent`, `PostCommentedEvent` (Task 4); `PostScoreService.computeScore` (Task 10); `EVENT_BUS`.
- Produces: nothing consumed by other tasks — this is the terminal wiring for like/comment counters.

- [ ] **Step 1: Write the failing test**

```ts
import { PostScoreListener } from './post-score.listener';
import { POST_EVENTS, PostLikedEvent, PostCommentedEvent } from '../events/post.events';

describe('PostScoreListener', () => {
  function build() {
    const handlers = new Map<string, (e: unknown) => unknown>();
    const bus = { subscribe: jest.fn((name: string, fn: (e: unknown) => unknown) => handlers.set(name, fn)) };
    const prisma = { post: { update: jest.fn() } };
    const scoring = { computeScore: jest.fn().mockReturnValue(4.2) };
    const listener = new PostScoreListener(bus as any, prisma as any, scoring as any);
    listener.onModuleInit();
    return { listener, bus, prisma, scoring, handlers };
  }

  it('increments likeCount and recomputes score on a like event', async () => {
    const { prisma, scoring, handlers } = build();
    prisma.post.update.mockResolvedValueOnce({
      id: 'p1',
      likeCount: 3,
      commentCount: 0,
      createdAt: new Date(),
    });

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'u1' }));

    expect(prisma.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'p1' },
      data: { likeCount: { increment: 1 }, commentCount: { increment: 0 } },
    });
    expect(prisma.post.update).toHaveBeenNthCalledWith(2, { where: { id: 'p1' }, data: { score: 4.2 } });
    expect(scoring.computeScore).toHaveBeenCalledWith(3, 0, expect.any(Date));
  });

  it('increments commentCount on a comment event', async () => {
    const { prisma, handlers } = build();
    prisma.post.update.mockResolvedValueOnce({
      id: 'p1',
      likeCount: 0,
      commentCount: 1,
      createdAt: new Date(),
    });

    await handlers.get(POST_EVENTS.COMMENTED)!(
      new PostCommentedEvent({ postId: 'p1', authorId: 'u1', commentId: 'c1' }),
    );

    expect(prisma.post.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'p1' },
      data: { likeCount: { increment: 0 }, commentCount: { increment: 1 } },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/listeners/post-score.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-score.listener.ts`**

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { POST_EVENTS, type PostCommentedEvent, type PostLikedEvent, type PostUnlikedEvent } from '../events/post.events';
import { PostScoreService } from '../services/post-score.service';

@Injectable()
export class PostScoreListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly prisma: PrismaService,
    private readonly scoring: PostScoreService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PostLikedEvent>(POST_EVENTS.LIKED, (e) => this.bump(e.payload.postId, 1, 0));
    this.bus.subscribe<PostUnlikedEvent>(POST_EVENTS.UNLIKED, (e) => this.bump(e.payload.postId, -1, 0));
    this.bus.subscribe<PostCommentedEvent>(POST_EVENTS.COMMENTED, (e) => this.bump(e.payload.postId, 0, 1));
  }

  private async bump(postId: string, likeDelta: number, commentDelta: number): Promise<void> {
    const post = await this.prisma.post.update({
      where: { id: postId },
      data: { likeCount: { increment: likeDelta }, commentCount: { increment: commentDelta } },
    });
    const score = this.scoring.computeScore(post.likeCount, post.commentCount, post.createdAt);
    await this.prisma.post.update({ where: { id: postId }, data: { score } });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/listeners/post-score.listener.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/listeners/post-score.listener.ts src/modules/posts/listeners/post-score.listener.spec.ts
git commit -m "feat(posts): add PostScoreListener incremental counters"
```

---

### Task 12: `post-notification.listener.ts` — notify the author

**Files:**
- Create: `src/modules/posts/listeners/post-notification.listener.ts`
- Test: `src/modules/posts/listeners/post-notification.listener.spec.ts`

**Interfaces:**
- Consumes: `POST_EVENTS`, `PostLikedEvent`, `PostCommentedEvent` (Task 4); `NOTIFICATION_SERVICE`/`INotificationService` (`src/modules/notification/interfaces/notification.interface`); `PROFILE_SERVICE`/`IProfileService`; `PUSH_CATEGORIES` (`src/modules/device/interfaces/push.constants`).

- [ ] **Step 1: Write the failing test**

```ts
import { NotificationType } from '@prisma/client';
import { PostNotificationListener } from './post-notification.listener';
import { POST_EVENTS, PostLikedEvent } from '../events/post.events';

describe('PostNotificationListener', () => {
  function build() {
    const handlers = new Map<string, (e: unknown) => unknown>();
    const bus = { subscribe: jest.fn((name: string, fn: (e: unknown) => unknown) => handlers.set(name, fn)) };
    const notifications = { create: jest.fn(), notify: jest.fn() };
    const profile = { getCards: jest.fn() };
    const prisma = { post: { findUnique: jest.fn() } };
    const listener = new PostNotificationListener(bus as any, notifications as any, profile as any, prisma as any);
    listener.onModuleInit();
    return { listener, bus, notifications, profile, prisma, handlers };
  }

  it('notifies the post author when someone else likes their post', async () => {
    const { notifications, profile, prisma, handlers } = build();
    prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'author1' });
    profile.getCards.mockResolvedValue([{ id: 'liker1', username: 'bob', fullName: 'Bob', avatarUrl: null }]);

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'liker1' }));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'author1', type: NotificationType.POST_LIKED, actorId: 'liker1' }),
    );
    expect(notifications.notify).toHaveBeenCalled();
  });

  it('does not notify when the author likes their own post', async () => {
    const { notifications, prisma, handlers } = build();
    prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'author1' });

    await handlers.get(POST_EVENTS.LIKED)!(new PostLikedEvent({ postId: 'p1', userId: 'author1' }));

    expect(notifications.create).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/listeners/post-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-notification.listener.ts`**

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';
import { PROFILE_SERVICE, type IProfileService } from 'src/modules/users/interfaces/profile.interface';
import { POST_EVENTS, type PostCommentedEvent, type PostLikedEvent } from '../events/post.events';

@Injectable()
export class PostNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(NOTIFICATION_SERVICE) private readonly notifications: INotificationService,
    @Inject(PROFILE_SERVICE) private readonly profile: IProfileService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<PostLikedEvent>(POST_EVENTS.LIKED, (e) => this.onLiked(e));
    this.bus.subscribe<PostCommentedEvent>(POST_EVENTS.COMMENTED, (e) => this.onCommented(e));
  }

  private async onLiked(e: PostLikedEvent): Promise<void> {
    const { postId, userId } = e.payload;
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.authorId === userId) return;

    const actor = await this.actorCard(userId);
    await this.notifications.create({
      userId: post.authorId,
      type: NotificationType.POST_LIKED,
      actorId: userId,
      entityType: 'post',
      entityId: postId,
      data: actor.data,
    });
    // Reuses the FOLLOW/social push category — a dedicated POST category
    // would need a new Android channel + client registration, out of scope here.
    await this.notifications.notify(post.authorId, {
      category: PUSH_CATEGORIES.FOLLOW,
      title: actor.name,
      body: 'Liked your post',
      threadId: `post_${postId}`,
      badge: 'unread',
      data: { type: 'post_liked', postId, userId },
    });
  }

  private async onCommented(e: PostCommentedEvent): Promise<void> {
    const { postId, authorId, commentId } = e.payload;
    const post = await this.prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.authorId === authorId) return;

    const actor = await this.actorCard(authorId);
    await this.notifications.create({
      userId: post.authorId,
      type: NotificationType.POST_COMMENTED,
      actorId: authorId,
      entityType: 'post',
      entityId: postId,
      data: actor.data,
    });
    await this.notifications.notify(post.authorId, {
      category: PUSH_CATEGORIES.FOLLOW,
      title: actor.name,
      body: 'Commented on your post',
      threadId: `post_${postId}`,
      badge: 'unread',
      data: { type: 'post_commented', postId, commentId, userId: authorId },
    });
  }

  private async actorCard(userId: string): Promise<{ name: string; data: Record<string, unknown> | null }> {
    const [card] = await this.profile.getCards([userId]);
    if (!card) return { name: 'Someone', data: null };
    return {
      name: card.fullName ?? card.username,
      data: { username: card.username, fullName: card.fullName, avatarUrl: card.avatarUrl },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/listeners/post-notification.listener.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/listeners/post-notification.listener.ts src/modules/posts/listeners/post-notification.listener.spec.ts
git commit -m "feat(posts): add PostNotificationListener"
```

---

### Task 13: `post-score.scheduler.ts` — periodic decay recompute

**Files:**
- Create: `src/modules/posts/scheduler/post-score.scheduler.ts`
- Test: `src/modules/posts/scheduler/post-score.scheduler.spec.ts`

**Interfaces:**
- Consumes: `PostScoreService.recomputeActivePosts` (Task 10); `QueueJobRegistry`, `QueueService`, `QUEUE_NAMES.RANKING_PROCESSING` (`src/infra/queue/*`).
- Produces: registers a job handler on the **existing** `RANKING_PROCESSING` queue via `QueueJobRegistry` — no new BullMQ processor is created; the existing `RankingsProcessor` (`src/modules/rankings/processors/rankings.processor.ts`) already dispatches unrecognized job names on that queue through the registry.

- [ ] **Step 1: Write the failing test**

```ts
import { PostScoreScheduler } from './post-score.scheduler';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';

describe('PostScoreScheduler', () => {
  function build() {
    const registry = { register: jest.fn() };
    const queue = { schedule: jest.fn().mockResolvedValue(undefined) };
    const scoring = { recomputeActivePosts: jest.fn() };
    const scheduler = new PostScoreScheduler(registry as any, queue as any, scoring as any);
    return { scheduler, registry, queue, scoring };
  }

  it('registers a handler on the shared RANKING_PROCESSING queue', async () => {
    const { scheduler, registry } = build();
    await scheduler.onModuleInit();
    expect(registry.register).toHaveBeenCalledWith(
      QUEUE_NAMES.RANKING_PROCESSING,
      'post.score.decay',
      expect.any(Function),
    );
  });

  it('schedules a repeatable job with a fixed jobId', async () => {
    const { scheduler, queue } = build();
    await scheduler.onModuleInit();
    expect(queue.schedule).toHaveBeenCalledWith(
      QUEUE_NAMES.RANKING_PROCESSING,
      'post.score.decay',
      {},
      { pattern: '*/5 * * * *' },
      { jobId: 'post-score-decay', removeOnComplete: true, removeOnFail: true },
    );
  });

  it('the registered handler calls PostScoreService.recomputeActivePosts', async () => {
    const { scheduler, registry, scoring } = build();
    await scheduler.onModuleInit();
    const handler = registry.register.mock.calls[0][2];

    await handler();

    expect(scoring.recomputeActivePosts).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/scheduler/post-score.scheduler.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post-score.scheduler.ts`**

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { QueueService } from 'src/infra/queue/queue.service';
import { QueueJobRegistry } from 'src/infra/queue/workers/queue-job.registry';
import { PostScoreService } from '../services/post-score.service';

const POST_SCORE_DECAY_JOB = 'post.score.decay';

/**
 * Registers on the shared RANKING_PROCESSING queue through QueueJobRegistry —
 * the same seam VideoRoomRankingJobsService uses — rather than a dedicated
 * processor, since BullMQ binds only one processor per queue name.
 */
@Injectable()
export class PostScoreScheduler implements OnModuleInit {
  private readonly logger = new Logger(PostScoreScheduler.name);

  constructor(
    private readonly registry: QueueJobRegistry,
    private readonly queue: QueueService,
    private readonly scoring: PostScoreService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.registry.register(QUEUE_NAMES.RANKING_PROCESSING, POST_SCORE_DECAY_JOB, () =>
      this.scoring.recomputeActivePosts(),
    );

    try {
      await this.queue.schedule(
        QUEUE_NAMES.RANKING_PROCESSING,
        POST_SCORE_DECAY_JOB,
        {},
        { pattern: '*/5 * * * *' },
        { jobId: 'post-score-decay', removeOnComplete: true, removeOnFail: true },
      );
      this.logger.log(`scheduled ${POST_SCORE_DECAY_JOB}`);
    } catch (err) {
      this.logger.error(`failed to schedule ${POST_SCORE_DECAY_JOB}: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/posts/scheduler/post-score.scheduler.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modules/posts/scheduler/post-score.scheduler.ts src/modules/posts/scheduler/post-score.scheduler.spec.ts
git commit -m "feat(posts): add PostScoreScheduler decay job"
```

---

### Task 14: `post.controller.ts`, `posts.module.ts`, module registration

**Files:**
- Create: `src/modules/posts/controllers/post.controller.ts`
- Create: `src/modules/posts/posts.module.ts`
- Modify: `src/modules/index.ts`
- Test: `src/modules/posts/controllers/post.controller.spec.ts`

**Interfaces:**
- Consumes: every service from Tasks 5–13.
- Produces: the full `posts` REST surface, registered in the app so `npm run build`/`npm test` exercise it end-to-end.

- [ ] **Step 1: Write the failing test**

```ts
import { PostController } from './post.controller';

describe('PostController', () => {
  function build() {
    const postService = { createPost: jest.fn(), deletePost: jest.fn() };
    const queryService = { getFeed: jest.fn(), getById: jest.fn() };
    const likeService = { like: jest.fn(), unlike: jest.fn() };
    const commentService = { addComment: jest.fn(), listComments: jest.fn(), deleteComment: jest.fn() };
    const reportService = { report: jest.fn() };
    const controller = new PostController(
      postService as any,
      queryService as any,
      likeService as any,
      commentService as any,
      reportService as any,
    );
    return { controller, postService, queryService, likeService, commentService, reportService };
  }

  it('create() creates the post then returns the shaped summary', async () => {
    const { controller, postService, queryService } = build();
    postService.createPost.mockResolvedValue({ id: 'p1' });
    queryService.getById.mockResolvedValue({ id: 'p1', description: 'hi' });

    const result = await controller.create({ description: 'hi' } as any, 'u1');

    expect(postService.createPost).toHaveBeenCalledWith({ authorId: 'u1', description: 'hi' });
    expect(queryService.getById).toHaveBeenCalledWith('p1', 'u1');
    expect(result).toEqual({ id: 'p1', description: 'hi' });
  });

  it('feed() passes the viewer id and query through to the query service', async () => {
    const { controller, queryService } = build();
    queryService.getFeed.mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 });

    await controller.feed({ page: 2, limit: 10 } as any, 'u1');

    expect(queryService.getFeed).toHaveBeenCalledWith('u1', 2, 10);
  });

  it('like() delegates to PostLikeService.like', async () => {
    const { controller, likeService } = build();
    await controller.like('p1', 'u1');
    expect(likeService.like).toHaveBeenCalledWith('p1', 'u1');
  });

  it('deleteComment() delegates to PostCommentService.deleteComment', async () => {
    const { controller, commentService } = build();
    await controller.deleteComment('c1', 'u1');
    expect(commentService.deleteComment).toHaveBeenCalledWith('c1', 'u1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/posts/controllers/post.controller.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `post.controller.ts`**

```ts
import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { CreateCommentDto } from '../dto/create-comment.dto';
import { CreatePostDto } from '../dto/create-post.dto';
import { FeedQueryDto } from '../dto/feed-query.dto';
import { ReportPostDto } from '../dto/report-post.dto';
import { PostCommentService } from '../services/post-comment.service';
import { PostLikeService } from '../services/post-like.service';
import { PostQueryService } from '../services/post-query.service';
import { PostReportService } from '../services/post-report.service';
import { PostService } from '../services/post.service';

@ApiTags('Posts & Feed')
@ApiBearerAuth()
@Controller('posts')
export class PostController {
  constructor(
    private readonly postService: PostService,
    private readonly queryService: PostQueryService,
    private readonly likeService: PostLikeService,
    private readonly commentService: PostCommentService,
    private readonly reportService: PostReportService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a post (photos and/or description)' })
  async create(@Body() dto: CreatePostDto, @CurrentUser('id') userId: string) {
    const post = await this.postService.createPost({ authorId: userId, ...dto });
    return this.queryService.getById(post.id, userId);
  }

  @Get('feed')
  @ApiOperation({ summary: 'Global feed, ranked by engagement score' })
  async feed(@Query() query: FeedQueryDto, @CurrentUser('id') userId: string) {
    return this.queryService.getFeed(userId, query.page, query.limit);
  }

  @Post(':id/like')
  @ApiOperation({ summary: 'Like a post' })
  async like(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.likeService.like(id, userId);
    return { liked: true };
  }

  @Delete(':id/like')
  @ApiOperation({ summary: 'Unlike a post' })
  async unlike(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.likeService.unlike(id, userId);
    return { liked: false };
  }

  @Get(':id/comments')
  @ApiOperation({ summary: 'List comments on a post' })
  async comments(@Param('id') id: string, @Query() query: FeedQueryDto) {
    return this.commentService.listComments(id, query.page, query.limit);
  }

  @Post(':id/comments')
  @ApiOperation({ summary: 'Comment on a post' })
  async comment(@Param('id') id: string, @Body() dto: CreateCommentDto, @CurrentUser('id') userId: string) {
    return this.commentService.addComment(id, userId, dto.body);
  }

  @Delete(':id/comments/:commentId')
  @ApiOperation({ summary: 'Delete a comment (author or moderator)' })
  async deleteComment(@Param('commentId') commentId: string, @CurrentUser('id') userId: string) {
    await this.commentService.deleteComment(commentId, userId);
    return { deleted: true };
  }

  @Post(':id/report')
  @ApiOperation({ summary: 'Report a post' })
  async report(@Param('id') id: string, @Body() dto: ReportPostDto, @CurrentUser('id') userId: string) {
    return this.reportService.report(id, userId, dto.reason);
  }

  // ─── Wildcard Routes (:id) ──────────────────────────────────────────
  @Get(':id')
  @ApiOperation({ summary: 'Get a post by id' })
  async getById(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.queryService.getById(id, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a post (author or moderator)' })
  async delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
    await this.postService.deletePost(id, userId);
    return { deleted: true };
  }
}
```

- [ ] **Step 4: Write `posts.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { PostController } from './controllers/post.controller';
import { PostScoreListener } from './listeners/post-score.listener';
import { PostNotificationListener } from './listeners/post-notification.listener';
import { PostScoreScheduler } from './scheduler/post-score.scheduler';
import { PostCommentService } from './services/post-comment.service';
import { PostLikeService } from './services/post-like.service';
import { PostQueryService } from './services/post-query.service';
import { PostReportService } from './services/post-report.service';
import { PostScoreService } from './services/post-score.service';
import { PostService } from './services/post.service';

@Module({
  controllers: [PostController],
  providers: [
    PostService,
    PostQueryService,
    PostLikeService,
    PostCommentService,
    PostReportService,
    PostScoreService,
    PostScoreListener,
    PostNotificationListener,
    PostScoreScheduler,
  ],
})
export class PostsModule {}
```

`PrismaService`, `EVENT_BUS`, `NOTIFICATION_SERVICE`, `PROFILE_SERVICE`, `PermissionResolver`, `QueueJobRegistry`, and `QueueService` are all provided by `@Global()` modules already imported at the app root (`PrismaModule`, `EventBusModule`, `NotificationModule`, `UsersModule`, `AuthorizationModule`, `QueueModule`) — `PostsModule` needs no `imports` of its own.

- [ ] **Step 5: Register in `src/modules/index.ts`**

Add the import line (alphabetically near other feature modules, e.g. after the `TasksModule` import):

```ts
import { PostsModule } from './posts/posts.module';
```

Add `PostsModule` to the `DOMAIN_MODULES` array (e.g. near `TasksModule`).

- [ ] **Step 6: Run the new controller test**

Run: `npx jest src/modules/posts/controllers/post.controller.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Run the full posts test suite and the app build**

Run: `npx jest src/modules/posts --silent`
Expected: PASS — all tasks' tests (Tasks 4–14) green together.

Run: `npx tsc --noEmit` (or `npm run build`, whichever this repo's `package.json` defines)
Expected: no type errors — confirms `posts.module.ts` and `src/modules/index.ts` wire together correctly and every cross-module DI token resolves.

- [ ] **Step 8: Commit**

```bash
git add src/modules/posts/controllers src/modules/posts/posts.module.ts src/modules/index.ts
git commit -m "feat(posts): wire PostController + PostsModule into the app"
```

---

## Manual verification (after Task 14)

The plan's automated tests are all unit-level (mocked Prisma). Before calling the backend half done, do one real end-to-end pass:

1. Start the app (`npm run start:dev` or whatever this repo's dev script is) against a real dev database.
2. `POST /storage/presign` with `category: 'post-images'` → `PUT` a real image to the returned `uploadUrl` → `POST /storage/confirm`.
3. `POST /posts` with the confirmed key(s) and a description.
4. `GET /posts/feed` — confirm the created post appears with a resolved `photoUrls[0]` that loads in a browser.
5. `POST /posts/:id/like` as a second user, then re-fetch the feed as that user — confirm `likedByMe: true` and `likeCount: 1`.
6. `POST /posts/:id/comments`, then `GET /posts/:id/comments` — confirm the comment appears with the commenter's card.
7. Wait 5 minutes (or manually trigger the queue job via Bull Board at `/admin/queues` if configured) and confirm the post's `score` in the DB has been recomputed.
