# Moderator Incognito Join, System-Attributed Warnings & Global 24h Ban Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a moderator silently observe any audio room, video room, or live stream (invisible in presence/counts, no discoverable profile), send warning messages that render as "System" (room-wide or private), and issue a 24-hour ban that immediately disconnects the target and blocks them from every room type until it expires — with a full audit trail and an admin panel surface to view/lift bans.

**Architecture:** A new small leaf module (`platform-moderation`) owns the cross-room concepts (the global ban table, the audit log, the admin REST surface) that audio-rooms/video-rooms/live-streaming each call into at their existing join/warn call sites — mirroring how the existing `moderation-approval` module is already consumed by all three. Incognito presence reuses live-streaming's already-working "separate Redis set, excluded from public counts" pattern, extended into the two presence services audio-rooms and video-rooms actually use (`PresenceService` and `VideoRoomPresenceService` are two different classes — confirmed by reading both). Room-wide warnings reuse each room type's already-unused `SYSTEM` chat-message-type enum value and the already-existing `SYSTEM_MODERATOR_ID`/anonymize() convention.

**Tech Stack:** NestJS, Prisma (PostgreSQL), Redis (ioredis via `RedisClient`), Socket.IO (via `SocketManager`/`IEventBus`), Jest.

**Spec:** [docs/superpowers/specs/2026-08-18-moderator-incognito-ban-system-design.md](../specs/2026-08-18-moderator-incognito-ban-system-design.md)

## Global Constraints

- "Moderator" (who gets incognito presence, can warn/ban) = any actor whose `roles` includes `MODERATOR`, `ADMIN`, or `SUPER_ADMIN` — matches the existing tri-role check already used at `audio-rooms.service.ts:547-548`, `video-room-member.service.ts:209-210`, `live-stream.service.ts:415-416`.
- Lifting a ban early (`unbanUser`) is restricted to `ADMIN`/`SUPER_ADMIN` only — never `MODERATOR`.
- A ban always requires a non-empty `reason` (validated at the DTO layer, `class-validator`).
- A global ban's Redis TTL (86400s) *is* the enforcement window — no cleanup/sweep job. The DB row's `status` is corrected to `EXPIRED` lazily on read.
- Existing per-room `RoomBan` (audio-rooms), `VideoRoomBlock` (video-rooms), `LiveStreamBan` (live-streaming) tables and flows are untouched — the new global ban is a separate, additional mechanism, not a replacement.
- No live-stream chat feature is introduced. The live-stream room-wide warning stays an ephemeral socket broadcast, exactly like the existing `broadcastSystemMessage` mute/kick/ban notices.
- Every new cross-cutting dependency (`PlatformBanService`, `PlatformModerationAuditService`) is injected `@Optional()` into the three room services, matching this codebase's existing convention for cross-module side-services (`investigationRecording`, `performanceStats`, `auditLog` are all `@Optional()` in every service touched by this plan) — real wiring always provides them via each module's `imports`, `@Optional()` only keeps unit tests from needing to stub them all.

---

## Task 1: Prisma schema for global bans + audit log

**Files:**
- Create: `prisma/schema/platform_moderation.prisma`
- Modify: none (Prisma auto-discovers files under `prisma/schema/`)

**Interfaces:**
- Produces: `PlatformUserBan`, `PlatformModerationAuditLog` Prisma models; `PlatformRoomType`, `PlatformBanStatus`, `PlatformModerationActionType` enums — every later task's repository/service code depends on these exact names.

- [ ] **Step 1: Write the schema file**

```prisma
// prisma/schema/platform_moderation.prisma

enum PlatformRoomType {
  AUDIO_ROOM
  VIDEO_ROOM
  LIVE_STREAM
}

enum PlatformBanStatus {
  ACTIVE
  LIFTED
  EXPIRED
}

enum PlatformModerationActionType {
  INCOGNITO_JOIN
  INCOGNITO_LEAVE
  WARNING_SENT
  BAN_ISSUED
  BAN_LIFTED
}

/// A cross-room 24h ban issued by a moderator. Unlike RoomBan/VideoRoomBlock/
/// LiveStreamBan (each scoped to one room/stream), this blocks the target from
/// joining ANY audio room, video room, or live stream until `expiresAt`. No
/// FK relations, matching every other room-moderation schema file's
/// "reference by id" convention.
model PlatformUserBan {
  id           String             @id @default(uuid())
  targetUserId String
  moderatorId  String
  reason       String
  roomType     PlatformRoomType
  originRoomId String
  status       PlatformBanStatus  @default(ACTIVE)
  bannedAt     DateTime           @default(now())
  expiresAt    DateTime
  liftedAt     DateTime?
  liftedBy     String?

  @@index([targetUserId, status])
  @@index([status, expiresAt])
  @@map("platform_user_bans")
}

/// Accountability trail for the covert moderator actions this feature adds
/// (incognito presence, warnings, global bans) — admin-visible only, never
/// shown to room participants.
model PlatformModerationAuditLog {
  id           String                        @id @default(uuid())
  moderatorId  String
  action       PlatformModerationActionType
  roomType     PlatformRoomType
  roomId       String
  targetUserId String?
  reason       String?
  createdAt    DateTime                      @default(now())

  @@index([moderatorId, createdAt])
  @@index([targetUserId, createdAt])
  @@map("platform_moderation_audit_logs")
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `npx prisma migrate dev --name platform_moderation_ban_and_audit`

Expected: a new folder under `prisma/schema/migrations/` containing the `CREATE TABLE` for both models plus the three enums; command exits 0. Per project convention (see `[[prisma_schema_client_drift]]` — CI drift check exists), **if the CLI prompts about resetting the dev database due to pre-existing drift, do not confirm it** — stop and flag this to the user instead of proceeding.

- [ ] **Step 3: Verify Prisma Client regenerated**

Run: `npx prisma generate`

Expected: exits 0; `node_modules/@prisma/client` now exports `PlatformUserBan`, `PlatformModerationAuditLog`, `PlatformRoomType`, `PlatformBanStatus`, `PlatformModerationActionType`.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema/platform_moderation.prisma prisma/schema/migrations
git commit -m "feat: add PlatformUserBan and PlatformModerationAuditLog schema"
```

---

## Task 2: `platform-moderation` module — repository + audit service

**Files:**
- Create: `src/modules/platform-moderation/repositories/platform-ban.repository.ts`
- Create: `src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts`
- Create: `src/modules/platform-moderation/services/platform-moderation-audit.service.ts`
- Create: `src/modules/platform-moderation/services/platform-moderation-audit.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`src/infra/prisma/prisma.service`), Prisma models from Task 1.
- Produces:
  - `PlatformBanRepository.create(input): Promise<PlatformUserBan>`
  - `PlatformBanRepository.findActive(targetUserId): Promise<PlatformUserBan | null>`
  - `PlatformBanRepository.findById(id): Promise<PlatformUserBan | null>`
  - `PlatformBanRepository.lift(id, liftedBy): Promise<PlatformUserBan>`
  - `PlatformBanRepository.list(filters, skip, limit): Promise<[PlatformUserBan[], number]>`
  - `PlatformModerationAuditService.record(input: { moderatorId: string; action: PlatformModerationActionType; roomType: PlatformRoomType; roomId: string; targetUserId?: string; reason?: string }): Promise<void>`
  - `PlatformModerationAuditService.list(filters, skip, limit): Promise<[PlatformModerationAuditLog[], number]>`
  - Both consumed by Task 3 (ban service), Tasks 6-10 (join/leave paths), Tasks 12-14 (warnings).

- [ ] **Step 1: Write the failing repository test**

```typescript
// src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts
import { PlatformBanRepository } from './platform-ban.repository';

describe('PlatformBanRepository', () => {
  let prisma: { platformUserBan: Record<string, jest.Mock> };
  let repo: PlatformBanRepository;

  beforeEach(() => {
    prisma = {
      platformUserBan: {
        create: jest.fn().mockResolvedValue({ id: 'ban-1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    repo = new PlatformBanRepository(prisma as never);
  });

  it('create() writes a row with the given fields', async () => {
    await repo.create({
      targetUserId: 'u1',
      moderatorId: 'm1',
      reason: 'spam',
      roomType: 'AUDIO_ROOM',
      originRoomId: 'r1',
      expiresAt: new Date('2026-08-19T00:00:00Z'),
    });
    expect(prisma.platformUserBan.create).toHaveBeenCalledWith({
      data: {
        targetUserId: 'u1',
        moderatorId: 'm1',
        reason: 'spam',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'r1',
        expiresAt: new Date('2026-08-19T00:00:00Z'),
      },
    });
  });

  it('findActive() queries for ACTIVE status only', async () => {
    await repo.findActive('u1');
    expect(prisma.platformUserBan.findFirst).toHaveBeenCalledWith({
      where: { targetUserId: 'u1', status: 'ACTIVE' },
    });
  });

  it('lift() flips status to LIFTED and stamps liftedBy/liftedAt', async () => {
    await repo.lift('ban-1', 'admin-1');
    expect(prisma.platformUserBan.update).toHaveBeenCalledWith({
      where: { id: 'ban-1' },
      data: { status: 'LIFTED', liftedBy: 'admin-1', liftedAt: expect.any(Date) },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts`
Expected: FAIL — `Cannot find module './platform-ban.repository'`

- [ ] **Step 3: Write the repository**

```typescript
// src/modules/platform-moderation/repositories/platform-ban.repository.ts
import { Injectable } from '@nestjs/common';
import { PlatformBanStatus, PlatformRoomType, PlatformUserBan } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreatePlatformBanInput {
  targetUserId: string;
  moderatorId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
  expiresAt: Date;
}

export interface ListPlatformBansFilter {
  status?: PlatformBanStatus;
  targetUserId?: string;
}

@Injectable()
export class PlatformBanRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePlatformBanInput): Promise<PlatformUserBan> {
    return this.prisma.platformUserBan.create({ data: input });
  }

  findActive(targetUserId: string): Promise<PlatformUserBan | null> {
    return this.prisma.platformUserBan.findFirst({
      where: { targetUserId, status: PlatformBanStatus.ACTIVE },
    });
  }

  findById(id: string): Promise<PlatformUserBan | null> {
    return this.prisma.platformUserBan.findUnique({ where: { id } });
  }

  lift(id: string, liftedBy: string): Promise<PlatformUserBan> {
    return this.prisma.platformUserBan.update({
      where: { id },
      data: { status: PlatformBanStatus.LIFTED, liftedBy, liftedAt: new Date() },
    });
  }

  async list(
    filter: ListPlatformBansFilter,
    skip: number,
    limit: number,
  ): Promise<[PlatformUserBan[], number]> {
    const where = {
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.targetUserId ? { targetUserId: filter.targetUserId } : {}),
    };
    return Promise.all([
      this.prisma.platformUserBan.findMany({
        where,
        skip,
        take: limit,
        orderBy: { bannedAt: 'desc' },
      }),
      this.prisma.platformUserBan.count({ where }),
    ]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/platform-moderation/repositories/platform-ban.repository.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing audit-service test**

```typescript
// src/modules/platform-moderation/services/platform-moderation-audit.service.spec.ts
import { PlatformModerationAuditService } from './platform-moderation-audit.service';

describe('PlatformModerationAuditService', () => {
  let prisma: { platformModerationAuditLog: Record<string, jest.Mock> };
  let service: PlatformModerationAuditService;

  beforeEach(() => {
    prisma = {
      platformModerationAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new PlatformModerationAuditService(prisma as never);
  });

  it('record() writes a row with the given fields', async () => {
    await service.record({
      moderatorId: 'm1',
      action: 'INCOGNITO_JOIN',
      roomType: 'AUDIO_ROOM',
      roomId: 'r1',
    });
    expect(prisma.platformModerationAuditLog.create).toHaveBeenCalledWith({
      data: {
        moderatorId: 'm1',
        action: 'INCOGNITO_JOIN',
        roomType: 'AUDIO_ROOM',
        roomId: 'r1',
        targetUserId: null,
        reason: null,
      },
    });
  });

  it('record() never throws — a logging failure must not break the caller', async () => {
    prisma.platformModerationAuditLog.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({ moderatorId: 'm1', action: 'BAN_ISSUED', roomType: 'VIDEO_ROOM', roomId: 'r1' }),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx jest src/modules/platform-moderation/services/platform-moderation-audit.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Write the audit service**

```typescript
// src/modules/platform-moderation/services/platform-moderation-audit.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PlatformModerationActionType, PlatformRoomType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface RecordAuditInput {
  moderatorId: string;
  action: PlatformModerationActionType;
  roomType: PlatformRoomType;
  roomId: string;
  targetUserId?: string;
  reason?: string;
}

export interface ListAuditFilter {
  moderatorId?: string;
  targetUserId?: string;
  action?: PlatformModerationActionType;
}

/**
 * Accountability trail for covert moderator actions. `record()` is called
 * from hot paths (room join, warn, ban) via `void this.platformAudit?.record(...)`
 * — it must never throw, or a logging hiccup would break the moderator action
 * it's meant to only observe.
 */
@Injectable()
export class PlatformModerationAuditService {
  private readonly logger = new Logger(PlatformModerationAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.prisma.platformModerationAuditLog.create({
        data: {
          moderatorId: input.moderatorId,
          action: input.action,
          roomType: input.roomType,
          roomId: input.roomId,
          targetUserId: input.targetUserId ?? null,
          reason: input.reason ?? null,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to write moderation audit log: ${(e as Error).message}`);
    }
  }

  async list(
    filter: ListAuditFilter,
    skip: number,
    limit: number,
  ): Promise<[Array<Record<string, unknown>>, number]> {
    const where = {
      ...(filter.moderatorId ? { moderatorId: filter.moderatorId } : {}),
      ...(filter.targetUserId ? { targetUserId: filter.targetUserId } : {}),
      ...(filter.action ? { action: filter.action } : {}),
    };
    return Promise.all([
      this.prisma.platformModerationAuditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.platformModerationAuditLog.count({ where }),
    ]);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/modules/platform-moderation/services/platform-moderation-audit.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add src/modules/platform-moderation/repositories src/modules/platform-moderation/services/platform-moderation-audit.service.ts src/modules/platform-moderation/services/platform-moderation-audit.service.spec.ts
git commit -m "feat: add PlatformBanRepository and PlatformModerationAuditService"
```

---

## Task 3: `PlatformBanService` — ban / check / lift

**Files:**
- Create: `src/modules/platform-moderation/services/platform-ban.service.ts`
- Create: `src/modules/platform-moderation/services/platform-ban.service.spec.ts`

**Interfaces:**
- Consumes: `PlatformBanRepository` (Task 2), `PlatformModerationAuditService` (Task 2), `PresenceService`'s `REDIS_CLIENT` token directly (for the fast-path TTL check), `SocketManager.disconnectUserEverywhere` (`src/infra/socket/socket.manager.ts:241-245`).
- Produces:
  - `PlatformBanService.banUser(input: { moderatorId: string; targetUserId: string; reason: string; roomType: PlatformRoomType; originRoomId: string }): Promise<PlatformUserBan>`
  - `PlatformBanService.assertNotGloballyBanned(userId: string): Promise<void>` — throws with reason+expiry if banned. **Consumed directly by Tasks 8, 9, 10.**
  - `PlatformBanService.unbanUser(adminId: string, banId: string): Promise<PlatformUserBan>`
  - `PlatformBanService.list(...)` — thin passthrough to the repository, used by Task 4's admin controller.

- [ ] **Step 1: Write the failing test**

```typescript
// src/modules/platform-moderation/services/platform-ban.service.spec.ts
import { ForbiddenException } from '@nestjs/common';
import { PlatformBanService } from './platform-ban.service';

describe('PlatformBanService', () => {
  let repo: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let redis: Record<string, jest.Mock>;
  let sockets: Record<string, jest.Mock>;
  let service: PlatformBanService;

  beforeEach(() => {
    repo = {
      create: jest.fn().mockResolvedValue({
        id: 'ban-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        expiresAt: new Date('2026-08-19T00:00:00.000Z'),
      }),
      findById: jest.fn().mockResolvedValue({
        id: 'ban-1',
        status: 'ACTIVE',
        targetUserId: 'target-1',
      }),
      lift: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
      list: jest.fn().mockResolvedValue([[], 0]),
    };
    audit = { record: jest.fn().mockResolvedValue(undefined) };
    redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    sockets = { disconnectUserEverywhere: jest.fn() };
    service = new PlatformBanService(repo as never, audit as never, redis as never, sockets as never);
  });

  describe('banUser', () => {
    it('rejects an empty reason', async () => {
      await expect(
        service.banUser({
          moderatorId: 'mod-1',
          targetUserId: 'target-1',
          reason: '   ',
          roomType: 'AUDIO_ROOM',
          originRoomId: 'room-1',
        }),
      ).rejects.toThrow('reason');
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates the ban row, mirrors it into Redis with a 24h TTL, disconnects the target everywhere, and audits it', async () => {
      await service.banUser({
        moderatorId: 'mod-1',
        targetUserId: 'target-1',
        reason: 'harassment',
        roomType: 'AUDIO_ROOM',
        originRoomId: 'room-1',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          moderatorId: 'mod-1',
          targetUserId: 'target-1',
          reason: 'harassment',
          roomType: 'AUDIO_ROOM',
          originRoomId: 'room-1',
        }),
      );
      expect(redis.set).toHaveBeenCalledWith(
        'platform-ban:user:target-1',
        expect.any(String),
        'EX',
        86400,
      );
      expect(sockets.disconnectUserEverywhere).toHaveBeenCalledWith('target-1');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ moderatorId: 'mod-1', action: 'BAN_ISSUED', targetUserId: 'target-1' }),
      );
    });
  });

  describe('assertNotGloballyBanned', () => {
    it('does nothing when the Redis key is absent', async () => {
      redis.get.mockResolvedValueOnce(null);
      await expect(service.assertNotGloballyBanned('target-1')).resolves.toBeUndefined();
    });

    it('throws with the reason and expiry when banned', async () => {
      redis.get.mockResolvedValueOnce(
        JSON.stringify({ reason: 'harassment', expiresAt: '2026-08-19T00:00:00.000Z' }),
      );
      await expect(service.assertNotGloballyBanned('target-1')).rejects.toThrow(ForbiddenException);
      await expect(service.assertNotGloballyBanned('target-1')).rejects.toThrow(/harassment/);
    });
  });

  describe('unbanUser', () => {
    it('deletes the Redis key and flips the DB row to LIFTED', async () => {
      const result = await service.unbanUser('admin-1', 'ban-1');
      expect(redis.del).toHaveBeenCalledWith('platform-ban:user:target-1');
      expect(repo.lift).toHaveBeenCalledWith('ban-1', 'admin-1');
      expect(result.status).toBe('LIFTED');
    });

    it('is idempotent — lifting an already-lifted ban does not error', async () => {
      repo.findById.mockResolvedValueOnce({ id: 'ban-1', status: 'LIFTED', targetUserId: 'target-1' });
      const result = await service.unbanUser('admin-1', 'ban-1');
      expect(repo.lift).not.toHaveBeenCalled();
      expect(result.status).toBe('LIFTED');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/platform-moderation/services/platform-ban.service.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the service**

```typescript
// src/modules/platform-moderation/services/platform-ban.service.ts
import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { PlatformRoomType, PlatformUserBan } from '@prisma/client';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PlatformBanRepository, type ListPlatformBansFilter } from '../repositories/platform-ban.repository';
import { PlatformModerationAuditService } from './platform-moderation-audit.service';

export interface BanUserInput {
  moderatorId: string;
  targetUserId: string;
  reason: string;
  roomType: PlatformRoomType;
  originRoomId: string;
}

const BAN_DURATION_SECONDS = 86400;

function banRedisKey(userId: string): string {
  return `platform-ban:user:${userId}`;
}

@Injectable()
export class PlatformBanService {
  constructor(
    private readonly repo: PlatformBanRepository,
    private readonly audit: PlatformModerationAuditService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly sockets: SocketManager,
  ) {}

  async banUser(input: BanUserInput): Promise<PlatformUserBan> {
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException('A ban reason is required.');
    }

    const expiresAt = new Date(Date.now() + BAN_DURATION_SECONDS * 1000);
    const ban = await this.repo.create({
      targetUserId: input.targetUserId,
      moderatorId: input.moderatorId,
      reason,
      roomType: input.roomType,
      originRoomId: input.originRoomId,
      expiresAt,
    });

    await this.redis.set(
      banRedisKey(input.targetUserId),
      JSON.stringify({ reason, expiresAt: expiresAt.toISOString() }),
      'EX',
      BAN_DURATION_SECONDS,
    );

    this.sockets.disconnectUserEverywhere(input.targetUserId);

    void this.audit.record({
      moderatorId: input.moderatorId,
      action: 'BAN_ISSUED',
      roomType: input.roomType,
      roomId: input.originRoomId,
      targetUserId: input.targetUserId,
      reason,
    });

    return ban;
  }

  async assertNotGloballyBanned(userId: string): Promise<void> {
    const raw = await this.redis.get(banRedisKey(userId));
    if (!raw) return;
    const { reason, expiresAt } = JSON.parse(raw) as { reason: string; expiresAt: string };
    throw new ForbiddenException(
      `You are banned from joining rooms until ${expiresAt} for: ${reason}`,
    );
  }

  async unbanUser(adminId: string, banId: string): Promise<PlatformUserBan> {
    const ban = await this.repo.findById(banId);
    if (!ban) {
      throw new BadRequestException('Ban not found.');
    }
    if (ban.status !== 'ACTIVE') {
      return ban;
    }

    await this.redis.del(banRedisKey(ban.targetUserId));
    const lifted = await this.repo.lift(banId, adminId);

    void this.audit.record({
      moderatorId: adminId,
      action: 'BAN_LIFTED',
      roomType: ban.roomType,
      roomId: ban.originRoomId,
      targetUserId: ban.targetUserId,
    });

    return lifted;
  }

  list(filter: ListPlatformBansFilter, skip: number, limit: number) {
    return this.repo.list(filter, skip, limit);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/platform-moderation/services/platform-ban.service.spec.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/modules/platform-moderation/services/platform-ban.service.ts src/modules/platform-moderation/services/platform-ban.service.spec.ts
git commit -m "feat: add PlatformBanService (issue/check/lift a global 24h ban)"
```

---

## Task 4: Admin controller + module wiring into `app.module.ts`

**Files:**
- Create: `src/modules/platform-moderation/dto/list-platform-bans.dto.ts`
- Create: `src/modules/platform-moderation/dto/ban-user-globally.dto.ts`
- Create: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts`
- Create: `src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts`
- Create: `src/modules/platform-moderation/platform-moderation.module.ts`
- Modify: `src/modules/index.ts` (add to `DOMAIN_MODULES`)

**Interfaces:**
- Consumes: `PlatformBanService` (Task 3), `Roles` decorator (`src/common/decorators/roles.decorator`), `PaginationQueryDto` (`src/common/dto/pagination.dto`), `buildPaginated` (`src/common/utils/pagination.util`).
- Produces: `BanUserGloballyDto` (exported for reuse by Tasks 8/9/10's room controllers), `GET/POST admin/moderation/bans` routes.

- [ ] **Step 1: Write the DTOs**

```typescript
// src/modules/platform-moderation/dto/ban-user-globally.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/** Ban a user from every room type (audio room, video room, live stream) for 24 hours. */
export class BanUserGloballyDto {
  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
```

```typescript
// src/modules/platform-moderation/dto/list-platform-bans.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PlatformBanStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';

export class ListPlatformBansDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PlatformBanStatus })
  @IsOptional()
  @IsEnum(PlatformBanStatus)
  status?: PlatformBanStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}
```

- [ ] **Step 2: Write the failing controller test**

```typescript
// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts
import { PlatformModerationAdminController } from './platform-moderation-admin.controller';

describe('PlatformModerationAdminController', () => {
  let bans: Record<string, jest.Mock>;
  let audit: Record<string, jest.Mock>;
  let controller: PlatformModerationAdminController;

  beforeEach(() => {
    bans = {
      list: jest.fn().mockResolvedValue([[{ id: 'ban-1' }], 1]),
      unbanUser: jest.fn().mockResolvedValue({ id: 'ban-1', status: 'LIFTED' }),
    };
    audit = { list: jest.fn().mockResolvedValue([[], 0]) };
    controller = new PlatformModerationAdminController(bans as never, audit as never);
  });

  it('listBans() paginates and returns the repository result', async () => {
    const result = await controller.listBans({ page: 1, limit: 20 } as never);
    expect(bans.list).toHaveBeenCalledWith({ status: undefined, targetUserId: undefined }, 0, 20);
    expect(result.total).toBe(1);
  });

  it('lift() delegates to PlatformBanService.unbanUser with the current admin id', async () => {
    await controller.lift({ id: 'admin-1', roles: ['ADMIN'] } as never, 'ban-1');
    expect(bans.unbanUser).toHaveBeenCalledWith('admin-1', 'ban-1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Write the controller**

```typescript
// src/modules/platform-moderation/controllers/platform-moderation-admin.controller.ts
import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { buildPaginated } from 'src/common/utils/pagination.util';
import { ListPlatformBansDto } from '../dto/list-platform-bans.dto';
import { PlatformModerationAuditService } from '../services/platform-moderation-audit.service';
import { PlatformBanService } from '../services/platform-ban.service';

@ApiTags('admin-moderation')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/moderation')
export class PlatformModerationAdminController {
  constructor(
    private readonly bans: PlatformBanService,
    private readonly audit: PlatformModerationAuditService,
  ) {}

  @Get('bans')
  async listBans(@Query() q: ListPlatformBansDto) {
    const [rows, total] = await this.bans.list(
      { status: q.status, targetUserId: q.targetUserId },
      q.skip,
      q.limit,
    );
    return buildPaginated(rows, total, q.page, q.limit);
  }

  @Post('bans/:id/lift')
  lift(@CurrentUser() user: AuthenticatedUser, @Param('id', ParseUuidPipe) id: string) {
    return this.bans.unbanUser(user.id, id);
  }

  @Get('audit-log')
  async auditLog(@Query() q: ListPlatformBansDto) {
    const [rows, total] = await this.audit.list({ targetUserId: q.targetUserId }, q.skip, q.limit);
    return buildPaginated(rows, total, q.page, q.limit);
  }
}
```

Note: `PaginationQueryDto` (verify in `src/common/dto/pagination.dto.ts`) already provides `page`, `limit`, and a computed `skip` getter — this mirrors exactly how `AudioRoomsAdminController`/`ChatService.listReports` already consume it (see `chat.service.ts:482-490`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/modules/platform-moderation/controllers/platform-moderation-admin.controller.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 6: Write the module**

```typescript
// src/modules/platform-moderation/platform-moderation.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformModerationAdminController } from './controllers/platform-moderation-admin.controller';
import { PlatformBanRepository } from './repositories/platform-ban.repository';
import { PlatformBanService } from './services/platform-ban.service';
import { PlatformModerationAuditService } from './services/platform-moderation-audit.service';

@Module({
  imports: [PrismaModule],
  controllers: [PlatformModerationAdminController],
  providers: [PlatformBanRepository, PlatformBanService, PlatformModerationAuditService],
  exports: [PlatformBanService, PlatformModerationAuditService],
})
export class PlatformModerationModule {}
```

- [ ] **Step 7: Register the module**

Open `src/modules/index.ts`. Add the import near the other cross-cutting moderation modules (alongside `ModerationApprovalModule`, line 61) and add `PlatformModerationModule` to the `DOMAIN_MODULES` array (alongside `ModerationApprovalModule`, line 128):

```typescript
import { PlatformModerationModule } from './platform-moderation/platform-moderation.module';
```

```typescript
  ModerationApprovalModule,
  PlatformModerationModule,
```

- [ ] **Step 8: Verify the app still boots**

Run: `npx nest build`
Expected: exits 0, no missing-provider errors.

- [ ] **Step 9: Commit**

```bash
git add src/modules/platform-moderation src/modules/index.ts
git commit -m "feat: add platform-moderation module with admin ban list/lift endpoints"
```

---

## Task 5: Error code for the global ban rejection

**Files:**
- Modify: `src/common/exceptions/error-codes.ts:109-111` (right after `ROOM_BANNED`/`ALREADY_BANNED`/`BAN_NOT_FOUND`)

**Interfaces:**
- Produces: `ERROR_CODES.PLATFORM_BANNED` — cosmetic/documentation only in this plan (Task 3's `assertNotGloballyBanned` throws a plain `ForbiddenException`, matching live-streaming's existing plain-exception convention rather than audio/video-rooms' `BusinessException` convention, since the check is shared code called from all three). Kept for parity with every other ban-rejection code already in this file, so clients have a stable code to branch on if they choose to parse the message.

- [ ] **Step 1: Add the code**

```typescript
  ROOM_BANNED: 'ROOM_BANNED',
  ALREADY_BANNED: 'ALREADY_BANNED',
  BAN_NOT_FOUND: 'BAN_NOT_FOUND',
  PLATFORM_BANNED: 'PLATFORM_BANNED',
```

- [ ] **Step 2: Commit**

```bash
git add src/common/exceptions/error-codes.ts
git commit -m "feat: add PLATFORM_BANNED error code"
```

---

## Task 6: `PresenceService` moderator-set split (audio-rooms' shared presence)

**Files:**
- Modify: `src/infra/redis/presence.service.ts`
- Create: `src/infra/redis/presence.service.spec.ts` (does not exist today — confirmed by `Glob **/presence.service*.ts`)

**Interfaces:**
- Produces: `PresenceService.joinRoom(roomId, userId, isModerator = false)`, `.leaveRoom(roomId, userId, isModerator = false)`, `.isInRoom(roomId, userId)` now checks both sets. `roomMemberCount`/`roomMembers` signatures unchanged (still public-set-only). **Consumed by Task 7.**

- [ ] **Step 1: Write the failing test**

```typescript
// src/infra/redis/presence.service.spec.ts
import { PresenceService } from './presence.service';

describe('PresenceService — room presence', () => {
  let client: Record<string, jest.Mock>;
  let service: PresenceService;

  beforeEach(() => {
    client = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      scard: jest.fn().mockResolvedValue(0),
      sismember: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new PresenceService(client as never);
  });

  it('joinRoom() with isModerator=true writes to the moderators set, not the public members set', async () => {
    await service.joinRoom('room-1', 'mod-1', true);
    expect(client.sadd).toHaveBeenCalledWith('presence:room:{room-1}:moderators', 'mod-1');
    expect(client.sadd).not.toHaveBeenCalledWith('presence:room:{room-1}:members', 'mod-1');
  });

  it('joinRoom() default (no third arg) writes to the public members set', async () => {
    await service.joinRoom('room-1', 'user-1');
    expect(client.sadd).toHaveBeenCalledWith('presence:room:{room-1}:members', 'user-1');
  });

  it('roomMemberCount() only counts the public set', async () => {
    await service.roomMemberCount('room-1');
    expect(client.scard).toHaveBeenCalledWith('presence:room:{room-1}:members');
  });

  it('isInRoom() returns true if the user is in either set', async () => {
    client.sismember.mockImplementation((key: string) =>
      Promise.resolve(key.endsWith(':moderators') ? 1 : 0),
    );
    await expect(service.isInRoom('room-1', 'mod-1')).resolves.toBe(true);
  });

  it('leaveRoom() with isModerator=true removes from the moderators set only', async () => {
    await service.leaveRoom('room-1', 'mod-1', true);
    expect(client.srem).toHaveBeenCalledWith('presence:room:{room-1}:moderators', 'mod-1');
    expect(client.srem).not.toHaveBeenCalledWith('presence:room:{room-1}:members', 'mod-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/infra/redis/presence.service.spec.ts`
Expected: FAIL — `joinRoom` called with 3 args doesn't yet branch (assertion on `sadd` moderators key fails; test 1 fails first).

- [ ] **Step 3: Modify the service**

In `src/infra/redis/presence.service.ts`, add a key builder next to `roomMembersKey` (after line 30):

```typescript
  private roomModeratorsKey(roomId: string): string {
    return `presence:room:{${roomId}}:moderators`;
  }
```

Replace `joinRoom` (lines 81-86) with:

```typescript
  async joinRoom(roomId: string, userId: string, isModerator = false): Promise<void> {
    const key = isModerator ? this.roomModeratorsKey(roomId) : this.roomMembersKey(roomId);
    await this.client.sadd(key, userId);
    await this.client.expire(key, 86400);
    await this.client.sadd(this.userRoomsKey(userId), roomId);
    await this.client.expire(this.userRoomsKey(userId), 86400);
  }
```

Replace `leaveRoom` (lines 88-95) with:

```typescript
  async leaveRoom(roomId: string, userId: string, isModerator = false): Promise<void> {
    const key = isModerator ? this.roomModeratorsKey(roomId) : this.roomMembersKey(roomId);
    await this.client.srem(key, userId);
    await this.client.srem(this.userRoomsKey(userId), roomId);
    if (!isModerator) {
      const count = await this.client.scard(this.roomMembersKey(roomId));
      if (count === 0) {
        await this.client.del(this.roomMembersKey(roomId));
      }
    }
  }
```

Replace `isInRoom` (lines 105-107) with:

```typescript
  async isInRoom(roomId: string, userId: string): Promise<boolean> {
    const [inPublic, inModerators] = await Promise.all([
      this.client.sismember(this.roomMembersKey(roomId), userId),
      this.client.sismember(this.roomModeratorsKey(roomId), userId),
    ]);
    return inPublic === 1 || inModerators === 1;
  }
```

`roomMemberCount` (101-103) and `roomMembers` (97-99) are unchanged — leave them exactly as they are, they already only read `roomMembersKey`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/infra/redis/presence.service.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infra/redis/presence.service.ts src/infra/redis/presence.service.spec.ts
git commit -m "feat: split room presence into public/moderator Redis sets"
```

---

## Task 7: `VideoRoomPresenceService` moderator set

**Files:**
- Modify: `src/modules/video-rooms/constants/video-room.constants.ts` (add key builder near `videoRoomViewersKey` etc., line ~192-204)
- Modify: `src/modules/video-rooms/services/video-room-presence.service.ts`
- Modify: `src/modules/video-rooms/interfaces/room-presence-manager.interface.ts` (add the 3 new method signatures, matching the existing viewer-method JSDoc style in that file)
- Create: `src/modules/video-rooms/services/video-room-presence.service.spec.ts`

**Interfaces:**
- Produces: `VideoRoomPresenceService.addModerator(roomId, userId)`, `.removeModerator(roomId, userId)`, `.isModeratorPresent(roomId, userId)`. `viewerCount`/`addViewer`/`removeViewer` unchanged. **Consumed by Task 9.**

- [ ] **Step 1: Add the key builder**

In `video-room.constants.ts`, after `videoRoomParticipantsKey` (line 202-204):

```typescript
export function videoRoomModeratorsKey(roomId: string): string {
  return `video-room:{${roomId}}:moderators`;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// src/modules/video-rooms/services/video-room-presence.service.spec.ts
import { VideoRoomPresenceService } from './video-room-presence.service';

describe('VideoRoomPresenceService — moderator presence', () => {
  let redis: Record<string, jest.Mock>;
  let service: VideoRoomPresenceService;

  beforeEach(() => {
    redis = {
      sadd: jest.fn().mockResolvedValue(1),
      srem: jest.fn().mockResolvedValue(1),
      sismember: jest.fn().mockResolvedValue(0),
      scard: jest.fn().mockResolvedValue(0),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new VideoRoomPresenceService(redis as never);
  });

  it('addModerator() writes to the moderators key, not the viewers key', async () => {
    await service.addModerator('room-1', 'mod-1');
    expect(redis.sadd).toHaveBeenCalledWith('video-room:{room-1}:moderators', 'mod-1');
    expect(redis.sadd).not.toHaveBeenCalledWith('video-room:{room-1}:viewers', 'mod-1');
  });

  it('viewerCount() is unaffected by moderator presence (reads only the viewers key)', async () => {
    await service.viewerCount('room-1');
    expect(redis.scard).toHaveBeenCalledWith('video-room:{room-1}:viewers');
  });

  it('isModeratorPresent() reads the moderators key', async () => {
    redis.sismember.mockResolvedValueOnce(1);
    await expect(service.isModeratorPresent('room-1', 'mod-1')).resolves.toBe(true);
    expect(redis.sismember).toHaveBeenCalledWith('video-room:{room-1}:moderators', 'mod-1');
  });

  it('clearRoom() also deletes the moderators key', async () => {
    await service.clearRoom('room-1');
    expect(redis.del).toHaveBeenCalledWith(
      'video-room:{room-1}:viewers',
      'video-room:{room-1}:hosts',
      'video-room:{room-1}:participants',
      'video-room:{room-1}:moderators',
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-presence.service.spec.ts`
Expected: FAIL — `addModerator` is not a function

- [ ] **Step 4: Modify the service**

In `video-room-presence.service.ts`, update the import (line 3-7) to include the new key builder:

```typescript
import {
  videoRoomHostsKey,
  videoRoomModeratorsKey,
  videoRoomParticipantsKey,
  videoRoomViewersKey,
} from '../constants/video-room.constants';
```

Add a new section after "Participants" (after line 75, before "Teardown"):

```typescript
  // ---- Moderators (incognito presence — excluded from every public count) ----

  async addModerator(roomId: string, userId: string): Promise<void> {
    await this.redis.sadd(videoRoomModeratorsKey(roomId), userId);
  }

  async removeModerator(roomId: string, userId: string): Promise<void> {
    await this.redis.srem(videoRoomModeratorsKey(roomId), userId);
  }

  async isModeratorPresent(roomId: string, userId: string): Promise<boolean> {
    return (await this.redis.sismember(videoRoomModeratorsKey(roomId), userId)) === 1;
  }
```

Update `clearRoom` (lines 79-86) to also delete the moderators key:

```typescript
  async clearRoom(roomId: string): Promise<void> {
    await this.redis.del(
      videoRoomViewersKey(roomId),
      videoRoomHostsKey(roomId),
      videoRoomParticipantsKey(roomId),
      videoRoomModeratorsKey(roomId),
    );
  }
```

- [ ] **Step 5: Update the interface**

Open `src/modules/video-rooms/interfaces/room-presence-manager.interface.ts`. Add these three method signatures, matching the existing style used for the `Participants` section:

```typescript
  addModerator(roomId: string, userId: string): Promise<void>;
  removeModerator(roomId: string, userId: string): Promise<void>;
  isModeratorPresent(roomId: string, userId: string): Promise<boolean>;
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-presence.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Commit**

```bash
git add src/modules/video-rooms/constants/video-room.constants.ts src/modules/video-rooms/services/video-room-presence.service.ts src/modules/video-rooms/services/video-room-presence.service.spec.ts src/modules/video-rooms/interfaces/room-presence-manager.interface.ts
git commit -m "feat: add moderator presence set to VideoRoomPresenceService"
```

---

## Task 8: Audio-rooms incognito join/leave

**Files:**
- Modify: `src/modules/audio-rooms/services/audio-rooms.service.ts` (constructor, `join()` lines 486-546, the old `isModerator` block at 547-575, `leave()` lines 580-599)
- Modify: `src/modules/audio-rooms/audio-rooms.module.ts` (import `PlatformModerationModule`)
- Modify: `src/modules/audio-rooms/services/audio-rooms.service.spec.ts` (existing file — add new test cases; do not overwrite existing ones)

**Interfaces:**
- Consumes: `PresenceService.joinRoom/leaveRoom(roomId, userId, isModerator)` (Task 6), `PlatformModerationAuditService.record` (Task 2).
- Produces: moderators joining `AudioRoomsService.join()` create no `RoomMember` row, are excluded from `roomMemberCount`, and never appear in `RoomJoinedEvent`.

- [ ] **Step 1: Write the failing tests**

Open `audio-rooms.service.spec.ts`. Find the `describe('join'` (or equivalent) block and add:

```typescript
describe('join — moderator incognito path', () => {
  const MODERATOR = { id: 'mod-1', roles: ['MODERATOR'] };

  it('does not create a RoomMember row for a moderator', async () => {
    await service.join(MODERATOR as never, 'room-1', {} as never);
    expect(repo.upsertActiveMember).not.toHaveBeenCalled();
  });

  it('does not publish RoomJoinedEvent for a moderator', async () => {
    await service.join(MODERATOR as never, 'room-1', {} as never);
    expect(bus.publish).not.toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringContaining('Joined') }));
  });

  it('routes the moderator into presence via the isModerator flag', async () => {
    await service.join(MODERATOR as never, 'room-1', {} as never);
    expect(presence.joinRoom).toHaveBeenCalledWith('room-1', 'mod-1', true);
  });

  it('writes an INCOGNITO_JOIN audit row', async () => {
    await service.join(MODERATOR as never, 'room-1', {} as never);
    expect(platformAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ moderatorId: 'mod-1', action: 'INCOGNITO_JOIN', roomType: 'AUDIO_ROOM', roomId: 'room-1' }),
    );
  });
});

describe('leave — moderator incognito path', () => {
  const MODERATOR = { id: 'mod-1', roles: ['MODERATOR'] };

  it('does not call deactivateMember for a moderator', async () => {
    await service.leave(MODERATOR as never, 'room-1');
    expect(repo.deactivateMember).not.toHaveBeenCalled();
  });

  it('removes the moderator from the moderator presence set', async () => {
    await service.leave(MODERATOR as never, 'room-1');
    expect(presence.leaveRoom).toHaveBeenCalledWith('room-1', 'mod-1', true);
  });
});
```

Adjust the mock setup at the top of the spec file (in the existing `beforeEach`) to include a `platformAudit` mock — `{ record: jest.fn().mockResolvedValue(undefined) }` — and pass it as the new last constructor argument when the spec constructs `service = new AudioRoomsService(...)`. Also ensure `repo.getMember`/`repo.findRoomRow` mocks used by existing tests return a room object with a `status` field so the unchanged `leave()` non-moderator path continues to pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/audio-rooms/services/audio-rooms.service.spec.ts -t "moderator incognito"`
Expected: FAIL — `presence.joinRoom` not called with 3 args / `platformAudit` undefined

- [ ] **Step 3: Add the constructor dependency**

Open `audio-rooms.service.ts`. Find its constructor's `@Optional()` parameter tail (mirrors the pattern already used in `moderation.service.ts:114-119` in this same module) and add:

```typescript
    @Optional() private readonly platformAudit?: PlatformModerationAuditService,
```

Add the import at the top:

```typescript
import { PlatformModerationAuditService } from 'src/modules/platform-moderation/services/platform-moderation-audit.service';
```

- [ ] **Step 4: Rewrite `join()`**

Replace the body from `await this.locks.withLock(...)` (line 511) through the end of the method (line 578) with:

```typescript
    const isModerator = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (isModerator) {
      const alreadyIncognito = await this.presence.isInRoom(roomId, actor.id);
      if (!alreadyIncognito) {
        await this.presence.joinRoom(roomId, actor.id, true);
      }
      if (this.performanceStats) {
        void this.performanceStats.recordAction(actor.id, 'ROOM_VISITED');
      }
      if (this.investigationRecording) {
        void this.moderation.listPendingReports(roomId).then((reports) =>
          Promise.all(
            reports.map((report) =>
              this.investigationRecording!.beginOrReuseRecording({
                moderatorId: actor.id,
                targetUserId: report.targetUserId,
                roomId,
                evidencePayload: { roomId, reportId: report.id, trigger: 'room_join' },
              }),
            ),
          ),
        );
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: actor.id,
          action: 'INCOGNITO_JOIN',
          roomType: 'AUDIO_ROOM',
          roomId,
        });
      }
      return this.getRoomDetail(roomId);
    }

    await this.locks.withLock(`audio-room:join:{${roomId}}`, async () => {
      const alreadyIn = await this.presence.isInRoom(roomId, actor.id);
      if (!alreadyIn) {
        const count = await this.presence.roomMemberCount(roomId);
        if (count >= room.maxParticipants) {
          throw new BusinessException(
            ERROR_CODES.ROOM_FULL,
            'This room is full.',
            HttpStatus.CONFLICT,
          );
        }
      }
      await this.presence.joinRoom(roomId, actor.id);
      const role = room.ownerId === actor.id ? RoomMemberRole.OWNER : RoomMemberRole.LISTENER;
      await this.repo.upsertActiveMember(roomId, actor.id, role, actor.id);
      await this.repo.upsertPresence(roomId, actor.id);

      if (room.ownerId === actor.id) {
        try {
          await this.seatsService.takeSeat(actor, roomId, 0);
        } catch (e) {
          this.logger.warn(
            `Could not auto-seat owner ${actor.id} on join: ${(e as Error).message}`,
          );
        }
      }
    });

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnJoin(roomId, count);
    await this.repo.trendingBump(roomId);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.JOINED);
    await this.bus.publish(
      new RoomJoinedEvent({ roomId, userId: actor.id, participantCount: count }),
    );

    return this.getRoomDetail(roomId);
```

This removes the old post-lock `isModerator` block (former lines 547-575) entirely — its two side effects (`performanceStats.recordAction`, `investigationRecording`) now live inside the new early-return branch above.

- [ ] **Step 5: Rewrite `leave()`**

Replace the full method body (lines 580-599) with:

```typescript
  async leave(actor: RoomActor, roomId: string): Promise<void> {
    const room = await this.repo.findRoomRow(roomId);
    if (!room) throw this.roomNotFound();

    const isModerator = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (isModerator) {
      await this.presence.leaveRoom(roomId, actor.id, true);
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: actor.id,
          action: 'INCOGNITO_LEAVE',
          roomType: 'AUDIO_ROOM',
          roomId,
        });
      }
      return;
    }

    await this.presence.leaveRoom(roomId, actor.id);
    await this.repo.deactivateMember(roomId, actor.id, actor.id);
    await this.repo.removePresence(roomId, actor.id);

    const count = await this.presence.roomMemberCount(roomId);
    await this.repo.bumpStatsOnLeave(roomId, count);
    await this.repo.appendLog(roomId, actor.id, RoomLogAction.LEFT);
    await this.bus.publish(
      new RoomLeftEvent({ roomId, userId: actor.id, participantCount: count }),
    );

    if (room.status === 'LIVE' && count <= 0) {
      await this.endRoomInternal(room, actor.id);
    }
  }
```

- [ ] **Step 6: Wire the module dependency**

In `audio-rooms.module.ts`, add the import:

```typescript
import { PlatformModerationModule } from 'src/modules/platform-moderation/platform-moderation.module';
```

Add `PlatformModerationModule` to the `imports` array (alongside `ModerationApprovalModule`, line 102).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/modules/audio-rooms/services/audio-rooms.service.spec.ts`
Expected: PASS, including all pre-existing tests in the file (confirms the non-moderator path is byte-for-byte unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/modules/audio-rooms/services/audio-rooms.service.ts src/modules/audio-rooms/services/audio-rooms.service.spec.ts src/modules/audio-rooms/audio-rooms.module.ts
git commit -m "feat: incognito moderator join/leave for audio rooms"
```

---

## Task 9: Video-rooms incognito join/leave

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts` (constructor, `join()` lines 110-253, `leave()` lines 260-301)
- Modify: `src/modules/video-rooms/video-rooms.module.ts` (import `PlatformModerationModule`)
- Modify: `src/modules/video-rooms/services/video-room-member.service.spec.ts` (existing file — add cases)

**Interfaces:**
- Consumes: `VideoRoomPresenceService.addModerator/removeModerator/isModeratorPresent` (Task 7), `PlatformModerationAuditService.record` (Task 2).
- Produces: moderators joining leave no `VideoRoomMember` row, no viewer-count bump, no `emitUserJoined` broadcast at all (not even the blanked-fields version).

- [ ] **Step 1: Write the failing tests**

Add to `video-room-member.service.spec.ts`:

```typescript
describe('join — moderator incognito path', () => {
  const MODERATOR = { id: 'mod-1', roles: ['MODERATOR'] };

  it('does not create a VideoRoomMember row for a moderator', async () => {
    await service.join(MODERATOR as never, 'room-1', {}, { socketId: 's1' } as never);
    expect(repo.upsertActiveMember).not.toHaveBeenCalled();
  });

  it('does not emit UserJoined for a moderator', async () => {
    await service.join(MODERATOR as never, 'room-1', {}, { socketId: 's1' } as never);
    expect(events.emitUserJoined).not.toHaveBeenCalled();
  });

  it('routes the moderator through addModerator, not addViewer', async () => {
    await service.join(MODERATOR as never, 'room-1', {}, { socketId: 's1' } as never);
    expect(presence.addModerator).toHaveBeenCalledWith('room-1', 'mod-1');
    expect(presence.addViewer).not.toHaveBeenCalled();
  });

  it('writes an INCOGNITO_JOIN audit row', async () => {
    await service.join(MODERATOR as never, 'room-1', {}, { socketId: 's1' } as never);
    expect(platformAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ moderatorId: 'mod-1', action: 'INCOGNITO_JOIN', roomType: 'VIDEO_ROOM', roomId: 'room-1' }),
    );
  });
});

describe('leave — moderator incognito path', () => {
  const MODERATOR = { id: 'mod-1', roles: ['MODERATOR'] };

  it('does not call deactivateMember for a moderator', async () => {
    await service.leave(MODERATOR as never, 'room-1', { socketId: 's1' });
    expect(repo.deactivateMember).not.toHaveBeenCalled();
  });

  it('removes the moderator via removeModerator, not removeViewer', async () => {
    await service.leave(MODERATOR as never, 'room-1', { socketId: 's1' });
    expect(presence.removeModerator).toHaveBeenCalledWith('room-1', 'mod-1');
    expect(presence.removeViewer).not.toHaveBeenCalled();
  });
});
```

Ensure the spec's `beforeEach` mock objects include `presence.addModerator`/`removeModerator`/`isModeratorPresent` (`jest.fn().mockResolvedValue(undefined)` / `false`) and a `platformAudit` mock, passed as the constructor's new final argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts -t "moderator incognito"`
Expected: FAIL — `presence.addModerator` not called / `platformAudit` undefined

- [ ] **Step 3: Add the constructor dependency**

In `video-room-member.service.ts`, add after the existing `@Optional() private readonly reportRepo?: VideoRoomReportRepository,` (line 100):

```typescript
    @Optional() private readonly platformAudit?: PlatformModerationAuditService,
```

Add the import at the top:

```typescript
import { PlatformModerationAuditService } from 'src/modules/platform-moderation/services/platform-moderation-audit.service';
```

- [ ] **Step 4: Rewrite `join()`**

Replace lines 133-250 (from `if (!privileged) {` through the closing of the `if (isModerator) { ... }` block and `return this.buildSyncPayload(room, roomId);`) with:

```typescript
      const isModerator = (actor.roles ?? []).some(
        (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
      );

      if (!privileged) {
        if (await this.moderation.isActivelyBlocked(roomId, actor.id)) {
          throw this.err(
            ERROR_CODES.VIDEO_ROOM_BLOCKED,
            'You are blocked from this room.',
            HttpStatus.FORBIDDEN,
          );
        }
      }

      if (room.isLocked && room.passwordHash && !alreadyMember && !privileged) {
        const invited = await this.seats.hasActiveRoomInvitation(roomId, actor.id);
        if (!invited) {
          const ok = dto.password
            ? await this.passwords.verify(dto.password, room.passwordHash)
            : false;
          if (!ok) {
            throw this.err(
              ERROR_CODES.VIDEO_ROOM_PASSWORD_INVALID,
              'Incorrect room password.',
              HttpStatus.BAD_REQUEST,
            );
          }
        }
      }

      if (isModerator) {
        const alreadyIncognito = await this.presence.isModeratorPresent(roomId, actor.id);
        if (!alreadyIncognito) {
          await this.presence.addModerator(roomId, actor.id);
        }
        await this.sessions.register({
          roomId,
          userId: actor.id,
          socketId: ctx.socketId,
          role: ConnectionType.SUBSCRIBER,
          deviceId: ctx.deviceId,
          platform: ctx.platform,
          ip: ctx.ip,
          sid: ctx.sid,
        });
        if (this.performanceStats) {
          void this.performanceStats.recordAction(actor.id, 'ROOM_VISITED');
        }
        if (this.investigationRecording && this.reportRepo) {
          void this.reportRepo.listPendingReports(roomId).then((reports) =>
            Promise.all(
              reports.map((report) =>
                this.investigationRecording!.beginOrReuseRecording({
                  moderatorId: actor.id,
                  targetUserId: report.targetUserId,
                  roomId,
                  evidencePayload: { roomId, reportId: report.id, trigger: 'room_join' },
                }),
              ),
            ),
          );
        }
        if (this.platformAudit) {
          void this.platformAudit.record({
            moderatorId: actor.id,
            action: 'INCOGNITO_JOIN',
            roomType: 'VIDEO_ROOM',
            roomId,
          });
        }
        return this.buildSyncPayload(room, roomId);
      }

      if (!alreadyMember) {
        const current = await this.presence.viewerCount(roomId);
        if (current >= room.maxViewers) {
          throw this.err(
            ERROR_CODES.VIDEO_ROOM_CAPACITY_EXCEEDED,
            'This room is full.',
            HttpStatus.CONFLICT,
          );
        }
      }

      // ---- Writes ----
      await this.presence.addViewer(roomId, actor.id);
      const role = isOwner ? VideoRoomMemberRole.OWNER : VideoRoomMemberRole.VIEWER;
      await this.repo.upsertActiveMember({
        roomId,
        userId: actor.id,
        role,
        deviceId: ctx.deviceId,
        platform: ctx.platform,
        actorId: actor.id,
      });
      await this.sessions.register({
        roomId,
        userId: actor.id,
        socketId: ctx.socketId,
        role: ConnectionType.SUBSCRIBER,
        deviceId: ctx.deviceId,
        platform: ctx.platform,
        ip: ctx.ip,
        sid: ctx.sid,
      });

      const liveCount = await this.presence.viewerCount(roomId);
      await this.state.applyUpdate(roomId, (cur) => ({
        status: room.status,
        isLocked: room.isLocked,
        viewerCount: liveCount,
        onlineCount: Math.max(0, liveCount - cur.reconnectingCount),
      }));
      await this.repo.bumpStatsOnJoin(roomId, liveCount);
      await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.JOINED });
      await this.audit(roomId, actor.id, 'member.joined', ctx);

      const joiner = (await this.identities.resolve([actor.id]).catch(() => null))?.get(actor.id);

      await this.events.emitUserJoined({
        roomId,
        userId: actor.id,
        username: joiner?.username,
        name: joiner?.displayName ?? undefined,
        avatarUrl: joiner?.avatarUrl ?? undefined,
        participantCount: liveCount,
      });
      await this.events.emitSessionCreated({ roomId, userId: actor.id, socketId: ctx.socketId });
      this.metrics.incJoin();
      this.metrics.setViewers(liveCount);

      return this.buildSyncPayload(room, roomId);
```

Note the non-moderator broadcast path no longer needs the `isModerator ? undefined : ...` conditionals on `username`/`name`/`avatarUrl` — moderators never reach this branch anymore, so real members always get their real identity, which is simpler and was in fact the pre-existing behavior for non-moderators.

- [ ] **Step 5: Rewrite `leave()`**

Replace lines 260-301 with:

```typescript
  async leave(
    actor: RoomActor,
    roomId: string,
    dto: { socketId?: string },
    ctx?: { ip?: string },
  ): Promise<void> {
    const room = await this.repo.findById(roomId);
    if (!room) {
      throw this.err(
        ERROR_CODES.VIDEO_ROOM_NOT_FOUND,
        `Video room ${roomId} was not found.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const isModerator = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );

    if (isModerator) {
      await this.presence.removeModerator(roomId, actor.id);
      if (dto.socketId) {
        await this.sessions.end(dto.socketId);
      } else {
        await this.sessions.endUserRoomSessions(roomId, actor.id);
      }
      if (this.platformAudit) {
        void this.platformAudit.record({
          moderatorId: actor.id,
          action: 'INCOGNITO_LEAVE',
          roomType: 'VIDEO_ROOM',
          roomId,
        });
      }
      return;
    }

    await this.presence.removeViewer(roomId, actor.id);
    const ended = dto.socketId
      ? [await this.sessions.end(dto.socketId)].filter(
          (r): r is VideoRoomSessionRecord => r !== null,
        )
      : await this.sessions.endUserRoomSessions(roomId, actor.id);
    await this.repo.deactivateMember(roomId, actor.id, actor.id);

    const liveCount = await this.presence.viewerCount(roomId);
    await this.state.applyUpdate(roomId, (cur) => ({
      viewerCount: liveCount,
      onlineCount: Math.max(0, liveCount - cur.reconnectingCount),
    }));
    await this.repo.bumpStatsOnLeave(roomId, liveCount);
    await this.repo.appendLog({ roomId, actorId: actor.id, action: VideoRoomLogAction.LEFT });
    await this.audit(roomId, actor.id, 'member.left', {
      socketId: dto.socketId ?? '',
      ip: ctx?.ip,
    });

    await this.events.emitUserLeft({ roomId, userId: actor.id, participantCount: liveCount });
    this.metrics.incLeave();
    this.metrics.setViewers(liveCount);
    for (const record of ended) {
      this.metrics.observeSessionDuration(this.durationSeconds(record));
    }
  }
```

- [ ] **Step 6: Wire the module dependency**

In `video-rooms.module.ts`, add the import and add `PlatformModerationModule` to the `imports` array (alongside `ModerationApprovalModule`, line 243).

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-member.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 8: Commit**

```bash
git add src/modules/video-rooms/services/video-room-member.service.ts src/modules/video-rooms/services/video-room-member.service.spec.ts src/modules/video-rooms/video-rooms.module.ts
git commit -m "feat: incognito moderator join/leave for video rooms"
```

---

## Task 10: Global ban join-gates (all three room types)

**Files:**
- Modify: `src/modules/audio-rooms/services/audio-rooms.service.ts` (`join()`, right after existing local ban check)
- Modify: `src/modules/video-rooms/services/video-room-member.service.ts` (`join()`, right after the `isModerator` computation, before the local block check)
- Modify: `src/modules/live-streaming/services/live-stream.service.ts` (`joinStream()`, right after existing local ban check, line ~422-424)
- Modify: each service's constructor + `.module.ts` import (audio-rooms and video-rooms already import `PlatformModerationModule` from Tasks 8/9 — this task adds `PlatformBanService` to the same import; live-streaming needs the import added fresh)
- Modify: `src/modules/live-streaming/live-streaming.module.ts`
- Modify: the three services' `.spec.ts` files

**Interfaces:**
- Consumes: `PlatformBanService.assertNotGloballyBanned(userId)` (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to `audio-rooms.service.spec.ts`:

```typescript
describe('join — global ban gate', () => {
  const USER = { id: 'user-1', roles: ['USER'] };

  it('rejects a globally-banned regular user before any room-local checks', async () => {
    platformBans.assertNotGloballyBanned.mockRejectedValueOnce(new Error('banned'));
    await expect(service.join(USER as never, 'room-1', {} as never)).rejects.toThrow('banned');
    expect(repo.upsertActiveMember).not.toHaveBeenCalled();
  });

  it('does not check the global ban for a moderator', async () => {
    const MODERATOR = { id: 'mod-1', roles: ['MODERATOR'] };
    await service.join(MODERATOR as never, 'room-1', {} as never);
    expect(platformBans.assertNotGloballyBanned).not.toHaveBeenCalled();
  });
});
```

Add the equivalent pair to `video-room-member.service.spec.ts` (swap `join(USER, 'room-1', {} as never)` for `join(USER, 'room-1', {}, { socketId: 's1' } as never)`) and to `live-stream.service.spec.ts` (there is already a `describe('joinStream ban gate', ...)` block per the existing tests referenced at `live-stream.service.spec.ts:233-246` — add cases there instead of a new `describe`):

```typescript
it('rejects a globally-banned regular user even if not banned from this specific stream', async () => {
  platformBans.assertNotGloballyBanned.mockRejectedValueOnce(new Error('globally banned'));
  await expect(subject.joinStream(STREAM_ID, viewer)).rejects.toThrow('globally banned');
});

it('does not check the global ban for a moderator', async () => {
  await subject.joinStream(STREAM_ID, modUser);
  expect(platformBans.assertNotGloballyBanned).not.toHaveBeenCalled();
});
```

In each spec's `beforeEach`, add a `platformBans = { assertNotGloballyBanned: jest.fn().mockResolvedValue(undefined) }` mock and pass it into the constructor as the new final argument.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest audio-rooms.service.spec video-room-member.service.spec live-stream.service.spec -t "global ban"`
Expected: FAIL — `platformBans.assertNotGloballyBanned` never called (join succeeds instead of rejecting)

- [ ] **Step 3: Audio-rooms — add the constructor param and call site**

In `audio-rooms.service.ts`, add after the `platformAudit` param added in Task 8:

```typescript
    @Optional() private readonly platformBans?: PlatformBanService,
```

Import: `import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';`

At the very top of `join()`, right after `const room = await this.getLiveRoomOrThrow(roomId);` (line 487) and before `assertNotKicked`/`assertNotBanned` (lines 491-492), insert:

```typescript
    const isModeratorActor = (actor.roles ?? []).some(
      (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
    );
    if (!isModeratorActor && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(actor.id);
    }
```

Note: this introduces `isModeratorActor` computed early; the `isModerator` const added in Task 8 (further down, before the incognito branch) is redundant with it — replace that later `const isModerator = ...` line with `const isModerator = isModeratorActor;` to avoid recomputing, keeping the rest of Task 8's code unchanged.

- [ ] **Step 4: Video-rooms — add the constructor param and call site**

In `video-room-member.service.ts`, add after the `platformAudit` param added in Task 9:

```typescript
    @Optional() private readonly platformBans?: PlatformBanService,
```

Import: `import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';`

Task 9 already computes `isModerator` right after the password-check block. Move that computation earlier — immediately after `const privileged = isOwner || this.isPlatformAdmin(actor);` (line 131) — and add the gate right there:

```typescript
      const isModerator = (actor.roles ?? []).some(
        (r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN',
      );
      if (!isModerator && this.platformBans) {
        await this.platformBans.assertNotGloballyBanned(actor.id);
      }
```

Remove the now-duplicate `const isModerator = ...` line that Task 9 placed later (right before the `if (isModerator) {` incognito branch) — it's computed once now, at the top.

- [ ] **Step 5: Live-streaming — add the constructor param and call site**

In `live-stream.service.ts`, add after `@Optional() private readonly reportRepo?: LiveStreamReportRepository,` (line 71):

```typescript
    @Optional() private readonly platformBans?: PlatformBanService,
```

Import: `import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';`

In `joinStream()`, right after the existing local-ban check (lines 419-424), insert:

```typescript
    if (!isModerator && this.platformBans) {
      await this.platformBans.assertNotGloballyBanned(user.id);
    }
```

(placed after the existing `if (!isModerator && (await this.moderationRepo.isActivelyBanned(...)))` block, reusing the `isModerator` already computed at line 415-417 in this file).

- [ ] **Step 6: Wire live-streaming's module import**

In `live-streaming.module.ts`, add the import and add `PlatformModerationModule` to the `imports` array (alongside `ModerationApprovalModule`, line 29). (Audio-rooms and video-rooms already import it from Tasks 8/9.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest audio-rooms.service.spec video-room-member.service.spec live-stream.service.spec`
Expected: PASS, including every pre-existing test in all three files.

- [ ] **Step 8: Commit**

```bash
git add src/modules/audio-rooms/services/audio-rooms.service.ts src/modules/audio-rooms/services/audio-rooms.service.spec.ts src/modules/video-rooms/services/video-room-member.service.ts src/modules/video-rooms/services/video-room-member.service.spec.ts src/modules/live-streaming/services/live-stream.service.ts src/modules/live-streaming/services/live-stream.service.spec.ts src/modules/live-streaming/live-streaming.module.ts
git commit -m "feat: enforce the global 24h ban at every room join gate"
```

---

## Task 11: Ban-issuing REST endpoints (all three moderation controllers)

**Files:**
- Modify: `src/modules/audio-rooms/controllers/moderation.controller.ts` (new route, near the existing `ban` route at line 85)
- Modify: `src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts` (new route, near `warn`)
- Modify: `src/modules/live-streaming/controllers/live-stream.controller.ts` (new route, near `:id/moderation`)
- Modify: each corresponding `*.module.ts` to ensure `PlatformBanService` is injectable into the controller (already exported by `PlatformModerationModule`, imported in Task 10 for all three — no further module change needed)
- Create/modify: each controller's `.spec.ts`

**Interfaces:**
- Consumes: `PlatformBanService.banUser` (Task 3), `BanUserGloballyDto` (Task 4).
- Produces: `POST rooms/:id/moderation/platform-ban/:userId`, `POST video-rooms/:id/moderation/platform-ban/:userId`, `POST live-streams/:id/moderation/platform-ban/:userId` — identical shape across all three: `{ reason: string }` body, `{ banned: true }` response.

- [ ] **Step 1: Write the failing test (audio-rooms controller, representative of all three)**

```typescript
// add to src/modules/audio-rooms/controllers/moderation.controller.spec.ts (create if absent)
import { ModerationController } from './moderation.controller';

describe('ModerationController — platformBan', () => {
  let moderation: Record<string, jest.Mock>;
  let platformBans: Record<string, jest.Mock>;
  let controller: ModerationController;

  beforeEach(() => {
    moderation = {};
    platformBans = { banUser: jest.fn().mockResolvedValue({ id: 'ban-1' }) };
    controller = new ModerationController(moderation as never, platformBans as never);
  });

  it('calls PlatformBanService.banUser with the actor, target, reason, and room context', async () => {
    const user = { id: 'mod-1', roles: ['MODERATOR'] } as never;
    const result = await controller.platformBan(user, 'room-1', 'target-1', { reason: 'harassment' } as never);
    expect(platformBans.banUser).toHaveBeenCalledWith({
      moderatorId: 'mod-1',
      targetUserId: 'target-1',
      reason: 'harassment',
      roomType: 'AUDIO_ROOM',
      originRoomId: 'room-1',
    });
    expect(result).toEqual({ banned: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/audio-rooms/controllers/moderation.controller.spec.ts`
Expected: FAIL — `controller.platformBan is not a function` / constructor arg count mismatch

- [ ] **Step 3: Audio-rooms controller**

In `moderation.controller.ts`, add the import:

```typescript
import { BanUserGloballyDto } from 'src/modules/platform-moderation/dto/ban-user-globally.dto';
import { PlatformBanService } from 'src/modules/platform-moderation/services/platform-ban.service';
```

Add `private readonly platformBans: PlatformBanService` to the constructor (alongside `moderation`).

Add the route near the existing `ban` route (after line 83, before the existing `ban` handler, or directly after it):

```typescript
  @Post(':id/moderation/platform-ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ban a user from every room type for 24 hours',
    description:
      'Unlike the room-local ban above, this blocks the target from joining ANY audio room, ' +
      'video room, or live stream for 24 hours, and disconnects them from wherever they ' +
      'currently are. Requires a reason.',
  })
  async platformBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserGloballyDto,
  ) {
    await this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'AUDIO_ROOM',
      originRoomId: id,
    });
    return { banned: true };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/modules/audio-rooms/controllers/moderation.controller.spec.ts`
Expected: PASS

- [ ] **Step 5: Video-rooms controller (same shape)**

In `video-rooms-moderation.controller.ts`, add the same two imports, add `private readonly platformBans: PlatformBanService` to the constructor, and add (near `warn`, after line 279's closing):

```typescript
  @Post(':id/moderation/platform-ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ban a user from every room type for 24 hours' })
  async platformBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) roomId: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserGloballyDto,
  ) {
    await this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'VIDEO_ROOM',
      originRoomId: roomId,
    });
    return { banned: true };
  }
```

Add a parallel test file `video-rooms-moderation.controller.spec.ts` mirroring Step 1's shape (constructor now takes 4 args: `moderation, reports, query, platformBans`).

- [ ] **Step 6: Live-streaming controller (same shape)**

In `live-stream.controller.ts`, add the same two imports, add `private readonly platformBans: PlatformBanService` to the constructor, and add (near the existing `:id/moderation` route, after line 125):

```typescript
  @Post(':id/moderation/platform-ban/:userId')
  @UseGuards(ShiftActiveGuard, SuspendedGuard)
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('live.stream.moderate')
  @ApiOperation({ summary: 'Ban a user from every room type for 24 hours' })
  async platformBan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) id: string,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() dto: BanUserGloballyDto,
  ) {
    await this.platformBans.banUser({
      moderatorId: user.id,
      targetUserId: userId,
      reason: dto.reason,
      roomType: 'LIVE_STREAM',
      originRoomId: id,
    });
    return { banned: true };
  }
```

Add a parallel test file `live-stream.controller.spec.ts` (constructor now takes 3 args: `service, reports, platformBans`).

- [ ] **Step 7: Run all three test files**

Run: `npx jest moderation.controller.spec video-rooms-moderation.controller.spec live-stream.controller.spec`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/modules/audio-rooms/controllers/moderation.controller.ts src/modules/audio-rooms/controllers/moderation.controller.spec.ts src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts src/modules/video-rooms/controllers/video-rooms-moderation.controller.spec.ts src/modules/live-streaming/controllers/live-stream.controller.ts src/modules/live-streaming/controllers/live-stream.controller.spec.ts
git commit -m "feat: expose the global platform-ban action on all three moderation controllers"
```

---

## Task 12: Room-wide/private system-attributed warnings — audio-rooms

**Files:**
- Modify: `src/modules/audio-rooms/services/moderation.service.ts` (constructor, `warn()` lines 525-585)
- Modify: `src/modules/audio-rooms/dto/moderation.dto.ts` (`WarnDto`, lines 77-83)
- Modify: `src/modules/audio-rooms/controllers/moderation.controller.ts` (`warn` handler — not shown in the excerpt read, but follows the same `@Post(':id/moderation/warn/:userId')` pattern as `kick`/`ban`; pass `dto.scope`)
- Modify: `src/modules/audio-rooms/services/moderation.service.spec.ts`

**Interfaces:**
- Consumes: `ChatRepository.createMessage` (`src/modules/audio-rooms/repositories/chat.repository.ts:50-60` — confirmed thin, Prisma-only, no circular import risk), `ChatMessageSentEvent` (`src/modules/audio-rooms/events/audio-room-chat.events.ts`), `ChatMessageType.SYSTEM` (already-unused enum value, `prisma/schema/audio_rooms_chat.prisma:94`), `SYSTEM_MODERATOR_ID` (already imported in this file, line 21).
- Produces: `ModerationService.warn(actor, roomId, targetUserId, reason, scope: 'PRIVATE' | 'ROOM' = 'PRIVATE', requestMeta?)`.

- [ ] **Step 1: Write the failing tests**

Add to `moderation.service.spec.ts` inside the `warn` describe block (or a new one):

```typescript
describe('warn — scope', () => {
  it('defaults to PRIVATE and does not touch chat (existing behavior preserved)', async () => {
    await service.warn(MOD, 'room-1', TARGET, 'be nice');
    expect(chatRepo.createMessage).not.toHaveBeenCalled();
    expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: expect.any(String) }));
  });

  it('scope=ROOM persists a SYSTEM chat message attributed to SYSTEM_MODERATOR_ID', async () => {
    await service.warn(MOD, 'room-1', TARGET, 'be nice', 'ROOM');
    expect(chatRepo.createMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room-1',
        senderId: '00000000-0000-0000-0000-000000000000',
        type: 'SYSTEM',
        content: 'be nice',
      }),
    );
  });

  it('scope=ROOM still sends the existing private notification too', async () => {
    const notifySpy = jest.spyOn(service as never, 'notifyUser');
    await service.warn(MOD, 'room-1', TARGET, 'be nice', 'ROOM');
    expect(notifySpy).toHaveBeenCalled();
  });
});
```

Add `chatRepo = { createMessage: jest.fn().mockResolvedValue({ id: 'msg-1', roomId: 'room-1', senderId: '00000000-0000-0000-0000-000000000000', type: 'SYSTEM', content: 'be nice', gifUrl: null, mentions: [], replyToId: null, createdAt: new Date() }) }` to the spec's mock setup and pass it into the `ModerationService` constructor as the new final argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts -t "warn — scope"`
Expected: FAIL — `warn` only takes 5 params today (no `scope`), `chatRepo.createMessage` never called

- [ ] **Step 3: Add `ChatRepository` to the constructor**

In `moderation.service.ts`, add after the last `@Optional()` param (line 119):

```typescript
    @Optional() private readonly chatRepo?: ChatRepository,
```

Import: `import { ChatRepository } from '../repositories/chat.repository';` and `import { ChatMessageSentEvent, type ChatMessagePayload } from '../events/audio-room-chat.events';`

(`ChatRepository` only depends on `PrismaService`/`CacheService`/`REDIS_CLIENT`/`BlockedWordRepository` — no import of `ModerationService` or `ChatService`, so this is safe: no circular dependency. Do **not** inject `ChatService` itself — it already imports `ModerationService`, at `chat.service.ts:67`, which would create a cycle.)

- [ ] **Step 4: Update `warn()`**

Replace the method signature (line 525-531) and the final two lines (583-584) of `warn()`:

```typescript
  async warn(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    scope: 'PRIVATE' | 'ROOM' = 'PRIVATE',
    requestMeta?: RequestMetadata,
  ): Promise<void> {
```

...(body unchanged through line 580)...

Replace the tail (lines 581-585) with:

```typescript
    await this.bus.publish(
      new MemberWarnedEvent({ roomId, moderatorId: actor.id, targetUserId, reason }),
    );
    await this.notifyUser(targetUserId, 'audio_room.warned', { roomId, reason });

    if (scope === 'ROOM' && this.chatRepo) {
      const message = await this.chatRepo.createMessage({
        roomId,
        senderId: SYSTEM_MODERATOR_ID,
        type: ChatMessageType.SYSTEM,
        content: reason,
        gifUrl: null,
        mentions: [],
        replyToId: null,
      });
      await this.bus.publish(
        new ChatMessageSentEvent({
          id: message.id,
          roomId: message.roomId,
          senderId: message.senderId,
          type: message.type,
          content: message.content,
          gifUrl: message.gifUrl,
          mentions: message.mentions,
          replyToId: message.replyToId,
          createdAt: message.createdAt.toISOString(),
        } as ChatMessagePayload),
      );
    }
  }
```

`ChatMessageType` is not currently imported into `moderation.service.ts` — add it to the existing `@prisma/client` import block at the top of the file (lines 2-11), which already imports `ModerationBanType`/`ModerationMuteType`/etc. from the same package:

```typescript
import {
  AudioRoom,
  ChatMessageType,
  ModerationActionType,
  ModerationBanType,
  ModerationMuteType,
  ReportReason,
  RoomBan,
  RoomKick,
  RoomMute,
} from '@prisma/client';
```

- [ ] **Step 5: Update `WarnDto`**

In `moderation.dto.ts`, replace the `WarnDto` class (lines 77-83):

```typescript
/** Issue a warning to a user (no state change, audited + notified). */
export class WarnDto {
  @ApiProperty({ maxLength: MOD_REASON_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(MOD_REASON_MAX)
  reason!: string;

  @ApiPropertyOptional({
    enum: ['PRIVATE', 'ROOM'],
    default: 'PRIVATE',
    description: 'PRIVATE notifies only the target user. ROOM also posts a System-attributed message visible to everyone in the room.',
  })
  @IsOptional()
  @IsIn(['PRIVATE', 'ROOM'])
  scope?: 'PRIVATE' | 'ROOM';
}
```

- [ ] **Step 6: Update the controller's `warn` handler**

Find the existing `warn` route in `moderation.controller.ts` (same file touched in Task 11) and update its call to pass the new argument:

```typescript
    await this.moderation.warn(this.actor(user), id, userId, dto.reason, dto.scope ?? 'PRIVATE', meta);
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx jest src/modules/audio-rooms/services/moderation.service.spec.ts`
Expected: PASS, including every pre-existing test (the default-PRIVATE path is unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/modules/audio-rooms/services/moderation.service.ts src/modules/audio-rooms/services/moderation.service.spec.ts src/modules/audio-rooms/dto/moderation.dto.ts src/modules/audio-rooms/controllers/moderation.controller.ts
git commit -m "feat: room-wide System-attributed warning messages for audio rooms"
```

---

## Task 13: Room-wide/private system-attributed warnings — video-rooms

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-system-message.service.ts` (add `emitCustom`)
- Modify: `src/modules/video-rooms/services/video-room-moderation.service.ts` (constructor, `warn()` lines 829-918)
- Modify: `src/modules/video-rooms/dto/moderation.dto.ts` (`WarnVideoRoomUserDto`, lines 160-177)
- Modify: `src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts` (`warn` handler, lines 268-280)
- Modify: `src/modules/video-rooms/services/video-room-moderation.service.spec.ts`
- Modify: `src/modules/video-rooms/services/video-room-system-message.service.spec.ts` (if it exists — check with Glob first; if absent, this task doesn't need to create one, since Task 13 Step 1's test covers the new method via `VideoRoomModerationService`)

**Interfaces:**
- Consumes: `VideoRoomChatRepository.createMessage` (already used internally by `VideoRoomSystemMessageService`), `ChatMessageSentEvent`.
- Produces: `VideoRoomSystemMessageService.emitCustom(roomId, content, metadata)`; `VideoRoomModerationService.warn(actor, roomId, targetUserId, reason, metadata?, scope: 'PRIVATE' | 'ROOM' = 'PRIVATE', requestMeta?)`.

**Why not reuse `emit(kind, ...)`:** `SYSTEM_MESSAGE_POLICY` maps a fixed `kind` to a **static** template string (confirmed by reading `persistRow` — `content` is the policy's literal `template`, with no placeholder substitution actually implemented despite the file's doc comment mentioning `{userId}`). A moderator's warning is free text the moderator types, not one of a fixed vocabulary, so this task adds a small sibling method that persists arbitrary content through the same repo/event path instead of forcing a new template into the static registry.

- [ ] **Step 1: Write the failing tests**

Add to `video-room-moderation.service.spec.ts`:

```typescript
describe('warn — scope', () => {
  it('defaults to PRIVATE and does not touch the system-message service', async () => {
    await service.warn(ACTOR, 'room-1', TARGET, 'be nice');
    expect(systemMessages.emitCustom).not.toHaveBeenCalled();
  });

  it('scope=ROOM persists a SYSTEM chat message via VideoRoomSystemMessageService', async () => {
    await service.warn(ACTOR, 'room-1', TARGET, 'be nice', undefined, 'ROOM');
    expect(systemMessages.emitCustom).toHaveBeenCalledWith('room-1', 'be nice', { targetUserId: TARGET });
  });
});
```

Add `systemMessages = { emitCustom: jest.fn().mockResolvedValue(undefined) }` to the spec's mocks and pass it as the constructor's new final argument.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts -t "warn — scope"`
Expected: FAIL — `warn` doesn't accept a `scope` param, `systemMessages` undefined

- [ ] **Step 3: Add `emitCustom` to `VideoRoomSystemMessageService`**

In `video-room-system-message.service.ts`, add a new public method after `emit` (after line 47):

```typescript
  /**
   * Free-text variant of `emit()` for content that isn't one of the fixed
   * `SYSTEM_MESSAGE_POLICY` templates — e.g. a moderator's own warning text.
   * Always persists (no room-size degradation — a moderator warning is not
   * presence churn).
   */
  async emitCustom(roomId: string, content: string, data: Record<string, unknown>): Promise<void> {
    const payload = await this.persistRow('MODERATOR_WARNING', roomId, content, data);
    await this.bus.publish(new ChatMessageSentEvent(payload));
  }
```

- [ ] **Step 4: Add the constructor dependency to `VideoRoomModerationService`**

In `video-room-moderation.service.ts`, add after `@Optional() @Inject(NOTIFICATION_SERVICE) private readonly notifications?: INotificationService,` (line 119):

```typescript
    @Optional() private readonly systemMessages?: VideoRoomSystemMessageService,
```

Import: `import { VideoRoomSystemMessageService } from './video-room-system-message.service';`

- [ ] **Step 5: Update `warn()`**

Replace the signature (lines 829-836):

```typescript
  async warn(
    actor: RoomActor,
    roomId: string,
    targetUserId: string,
    reason: string,
    metadata?: Record<string, unknown>,
    scope: 'PRIVATE' | 'ROOM' = 'PRIVATE',
    requestMeta?: RequestMetadata,
  ): Promise<void> {
```

Replace the tail (lines 907-918):

```typescript
    await this.bus.publish(
      new UserWarnedEvent({
        roomId: ref.id,
        moderatorId: actor.id,
        targetUserId,
        reason,
        metadata: metadata ?? null,
      }),
    );
    this.metrics.incWarning();
    await this.notifyUser(targetUserId, 'video_room.warned', { roomId: ref.id, reason });

    if (scope === 'ROOM' && this.systemMessages) {
      await this.systemMessages.emitCustom(ref.id, reason, { targetUserId });
    }
  }
```

- [ ] **Step 6: Update `WarnVideoRoomUserDto`**

In `moderation.dto.ts` (video-rooms), add to `WarnVideoRoomUserDto` (after line 176, before the closing brace):

```typescript
  @ApiPropertyOptional({
    enum: ['PRIVATE', 'ROOM'],
    default: 'PRIVATE',
    description: 'PRIVATE notifies only the target user. ROOM also posts a System-attributed chat message visible to everyone in the room.',
  })
  @IsOptional()
  @IsIn(['PRIVATE', 'ROOM'])
  scope?: 'PRIVATE' | 'ROOM';
```

(Add `IsIn` to the existing `class-validator` import at the top of the file if not already present.)

- [ ] **Step 7: Update the controller**

In `video-rooms-moderation.controller.ts`, update the `warn` handler (lines 274-280):

```typescript
    return this.moderation.warn(
      this.actor(user),
      roomId,
      dto.userId,
      dto.reason,
      dto.metadata,
      dto.scope ?? 'PRIVATE',
      meta,
    );
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx jest src/modules/video-rooms/services/video-room-moderation.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 9: Commit**

```bash
git add src/modules/video-rooms/services/video-room-system-message.service.ts src/modules/video-rooms/services/video-room-moderation.service.ts src/modules/video-rooms/services/video-room-moderation.service.spec.ts src/modules/video-rooms/dto/moderation.dto.ts src/modules/video-rooms/controllers/video-rooms-moderation.controller.ts
git commit -m "feat: room-wide System-attributed warning messages for video rooms"
```

---

## Task 14: Room-wide/private system-attributed warnings — live-streaming

**Files:**
- Modify: `src/modules/live-streaming/services/live-stream.service.ts` (`enforceModerationAction`'s `WARN` case doesn't currently exist as a distinct branch — check; `broadcastSystemMessage`, lines 331-338; `moderateUser`/`ModerateStreamUserDto` action union)
- Modify: `src/modules/live-streaming/constants/live-stream-moderation.constants.ts` (add a `USER_WARNED` socket event name next to `USER_MUTED`/`USER_KICKED`/`USER_BANNED`)
- Modify: `src/modules/live-streaming/controllers/live-stream.controller.ts` (`ModerateStreamUserDto` — add `scope`)
- Modify: `src/modules/live-streaming/services/live-stream.service.spec.ts`

**Interfaces:**
- Produces: `LIVE_STREAM_SOCKET_EVENTS.USER_WARNED`; `enforceModerationAction`'s `WARN` case broadcasts a scope-aware system message (room-wide banner via the existing `emitToNamespaceRoom` ephemeral path, or nothing extra beyond the existing private path when `scope==='PRIVATE'`).

**Confirmed current behavior:** `moderateUser()` (line 142) always calls `enforceModerationAction(stream.id, input)` (line 217) for every action, including `WARN` — but `enforceModerationAction` (lines 254-322) only has branches for `'MUTE'`, `'KICK'`, `'BAN'`. Today `WARN` falls through that method doing nothing; the only effect of a `WARN` today is the audit row + investigation recording + performance-stat bump that `moderateUser` itself does unconditionally for every action (lines 174-213), plus the existing private notification path elsewhere in the class. This task adds a fourth branch to `enforceModerationAction` for `WARN`, gated on `scope === 'ROOM'`.

- [ ] **Step 1: Write the failing test**

```typescript
// add to live-stream.service.spec.ts
describe('moderateUser — WARN scope', () => {
  it('scope=PRIVATE (default) does not broadcast to the room', async () => {
    await subject.moderateUser({
      streamId: STREAM_ID,
      moderatorId: 'mod-1',
      targetUserId: 'target-1',
      action: 'WARN',
      reason: 'be nice',
    });
    expect(sockets.emitToNamespaceRoom).not.toHaveBeenCalledWith(
      expect.anything(),
      STREAM_ID,
      LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
      expect.anything(),
    );
  });

  it('scope=ROOM broadcasts a system message with the moderator identity anonymized', async () => {
    await subject.moderateUser({
      streamId: STREAM_ID,
      moderatorId: 'mod-1',
      targetUserId: 'target-1',
      action: 'WARN',
      reason: 'be nice',
      scope: 'ROOM',
    });
    expect(sockets.emitToNamespaceRoom).toHaveBeenCalledWith(
      LIVE_STREAM_NAMESPACE,
      STREAM_ID,
      LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
      expect.objectContaining({
        streamId: STREAM_ID,
        moderatorId: SYSTEM_MODERATOR_ID,
        systemMessage: 'be nice',
      }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/modules/live-streaming/services/live-stream.service.spec.ts -t "WARN scope"`
Expected: FAIL — `moderateUser` doesn't accept/thread `scope`, `USER_WARNED` doesn't exist yet

- [ ] **Step 3: Add the socket event constant**

In `live-stream-moderation.constants.ts`, find the `LIVE_STREAM_SOCKET_EVENTS` object (near `USER_MUTED`/`USER_KICKED`/`USER_BANNED`, line ~14+) and add:

```typescript
  USER_WARNED: 'live_stream.user_warned',
```

- [ ] **Step 4: Add `scope` to the moderation input type and controller DTO**

In `live-stream.service.ts`, update the `LiveStreamModerationInput` interface (lines 47-55):

```typescript
export interface LiveStreamModerationInput {
  streamId: string;
  moderatorId: string;
  targetUserId: string;
  action: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
  durationMinutes?: number;
  /** Only meaningful for WARN: PRIVATE (default) or ROOM-wide system broadcast. */
  scope?: 'PRIVATE' | 'ROOM';
}
```

In `live-stream.controller.ts`, update `ModerateStreamUserDto` (lines 32-38):

```typescript
class ModerateStreamUserDto {
  targetUserId!: string;
  action!: 'WARN' | 'MUTE' | 'KICK' | 'BAN';
  reason?: string;
  durationMinutes?: number;
  scope?: 'PRIVATE' | 'ROOM';
}
```

And thread it through the `moderateUser` call (lines 114-122):

```typescript
    return this.service.moderateUser(
      {
        streamId: id,
        moderatorId: user.id,
        targetUserId: dto.targetUserId,
        action: dto.action,
        reason: dto.reason,
        durationMinutes: dto.durationMinutes,
        scope: dto.scope,
      },
      meta,
    );
```

- [ ] **Step 5: Add the `WARN` branch to `enforceModerationAction`**

In `live-stream.service.ts`, `enforceModerationAction` (lines 254-322) currently has `if` blocks for `'MUTE'` (258-282), `'KICK'` (284-292), and `'BAN'` (294-321), in that order, each ending with a `return` (MUTE, KICK) or falling through to the closing brace (BAN). Add a fourth block, placed before the `'MUTE'` check (so it short-circuits first, matching the order actions are declared in the type union) — right after the method signature (line 254-257):

```typescript
  private async enforceModerationAction(
    streamId: string,
    input: LiveStreamModerationInput,
  ): Promise<void> {
    if (input.action === 'WARN') {
      if (input.scope === 'ROOM') {
        this.sockets.emitToNamespaceRoom(
          LIVE_STREAM_NAMESPACE,
          streamId,
          LIVE_STREAM_SOCKET_EVENTS.USER_WARNED,
          {
            streamId,
            targetUserId: input.targetUserId,
            moderatorId: SYSTEM_MODERATOR_ID,
            systemMessage: input.reason ?? 'A moderator issued a warning.',
          },
        );
      }
      return;
    }

    if (input.action === 'MUTE') {
```

(The rest of the method — the existing `MUTE`/`KICK`/`BAN` blocks — is unchanged; only the new `WARN` block and the `if (input.action === 'MUTE')` line it precedes are shown above for placement context.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx jest src/modules/live-streaming/services/live-stream.service.spec.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Commit**

```bash
git add src/modules/live-streaming/services/live-stream.service.ts src/modules/live-streaming/services/live-stream.service.spec.ts src/modules/live-streaming/constants/live-stream-moderation.constants.ts src/modules/live-streaming/controllers/live-stream.controller.ts
git commit -m "feat: room-wide System-attributed warning broadcast for live streams"
```

---

## Task 15: Full-suite regression pass

**Files:** none created/modified — verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the entire test suite**

Run: `npx jest`
Expected: all suites pass, including every file touched across Tasks 1-14 and everything untouched.

- [ ] **Step 2: Type-check and build**

Run: `npx tsc --noEmit && npx nest build`
Expected: both exit 0.

- [ ] **Step 3: Confirm Prisma schema/client are in sync**

Run: `npx prisma validate`
Expected: exits 0, no drift.

- [ ] **Step 4: Report**

No commit for this task — it's a verification checkpoint. If anything fails, return to the task that introduced the regression and fix it there (new commit on that task, not a blanket fix-up commit at the end).
