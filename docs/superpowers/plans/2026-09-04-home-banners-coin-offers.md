# Home Banners & Coin Offers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Super-Admin-managed Home Banners and percentage-based Coin Offers across `soulzaa-backend`, `soulzaa-superadmins`, and `soulzaa-mobile`.

**Architecture:** Two new Prisma models (`HomeBanner`, `CoinOffer`) and two new NestJS modules following the existing `wealth` module shape (admin + public controller, service, repository, DTOs). `PurchaseOrderService` is extended to resolve and lock in an eligible offer at order-creation time, mirroring how `package.bonusCoins` already works. Super Admin gets two new CRUD screens copying `CoinPackagesScreen`'s shape. Mobile gets a banner carousel (reusing the existing unused `EventBannerCarousel` pattern) and a coin-offer badge + one-shot celebration animation on the Buy Coins screen.

**Tech Stack:** NestJS + Prisma + PostgreSQL (backend), React + Vite + `@soulzaa/shared` (super admin), Flutter + Riverpod + GoRouter + Dio (mobile).

**Spec:** `docs/superpowers/specs/2026-09-04-home-banners-coin-offers-design.md`

## Global Constraints

- "New user" = zero `PurchaseOrder` rows with `status = COMPLETED`, ever — evaluated server-side at purchase time. UI label everywhere: **"First Coin Purchase Only"** (enum value stays `FIRST_PURCHASE_ONLY`).
- At most one active `CoinOffer` per `eligibility` segment at a time — enforced by a partial unique index AND a service-layer auto-deactivate-on-activate.
- Offer bonus is computed once, at `PurchaseOrder` creation, and never recomputed later.
- `BannerRedirectPage` v1 values: `HOME, COINS, VIP, EVENTS, WALLET, AUDIO_ROOM, EXTERNAL_URL` — `AUDIO_ROOM`/`EXTERNAL_URL` are the only two needing an extra field (`redirectTargetId`, `externalUrl` respectively).
- No git commits as part of any task in this plan — the user stages/commits changes themselves. Every "Commit" step below is replaced with a note to leave changes uncommitted.
- No automated test suites are to be run by the executor as a matter of routine ("don't test, don't waste time" — user's standing instruction from earlier in this session) — but the money-bearing offer-resolution logic in Task 4 still gets a unit test written and run once, since that's correctness-of-implementation, not a full-suite run.

---

## Task 1: Prisma schema — `HomeBanner`, `CoinOffer`, `PurchaseOrder` additions

**Files:**
- Create: `prisma/schema/promotions.prisma`
- Modify: `prisma/schema/payments.prisma` (add fields to `PurchaseOrder`)

**Interfaces:**
- Produces: `HomeBanner`, `CoinOffer`, `BannerRedirectPage`, `CoinOfferEligibility` Prisma models/enums; `PurchaseOrder.appliedCoinOfferId`, `PurchaseOrder.offerBonusCoinsAmount`, `PurchaseOrder.appliedCoinOffer` relation.

- [ ] **Step 1: Write `prisma/schema/promotions.prisma`**

```prisma
/// Home Screen banners — Super-Admin-managed, ordered, with a redirect
/// destination. `imageKey` is an S3 key resolved to a URL at read time via
/// MediaUrlResolver, same convention as WealthLevel.iconUrl.
enum BannerRedirectPage {
  HOME
  COINS
  VIP
  EVENTS
  WALLET
  /// Deep-links to a specific Audio Room — requires redirectTargetId.
  AUDIO_ROOM
  /// Opens in an in-app webview — requires externalUrl.
  EXTERNAL_URL
}

model HomeBanner {
  id               String             @id @default(uuid()) @db.Uuid
  title            String?
  imageKey         String
  redirectPage     BannerRedirectPage
  /// Audio room id — set only when redirectPage = AUDIO_ROOM.
  redirectTargetId String?            @db.Uuid
  /// Set only when redirectPage = EXTERNAL_URL.
  externalUrl      String?
  isActive         Boolean            @default(true)
  sortOrder        Int                @default(0)
  createdBy        String?            @db.Uuid
  createdAt        DateTime           @default(now())
  updatedAt        DateTime           @updatedAt

  @@index([isActive, sortOrder])
  @@map("home_banners")
}

/// Who a CoinOffer applies to. FIRST_PURCHASE_ONLY / EXISTING_USERS_ONLY are
/// evaluated against PurchaseOrder.status = COMPLETED history at purchase
/// time — never account-creation age. See CoinOfferService.resolveEligibleOffer.
enum CoinOfferEligibility {
  FIRST_PURCHASE_ONLY
  EXISTING_USERS_ONLY
  ALL_USERS
}

/// A percentage-based bonus-coin promotion. At most one row per
/// `eligibility` segment may have isActive = true at once — see the partial
/// unique index below and CoinOfferService.toggle.
model CoinOffer {
  id          String               @id @default(uuid()) @db.Uuid
  title       String
  percentage  Int
  eligibility CoinOfferEligibility @default(ALL_USERS)
  isActive    Boolean              @default(true)
  createdBy   String?              @db.Uuid
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt

  orders      PurchaseOrder[]

  @@index([eligibility, isActive])
  @@map("coin_offers")
}
```

- [ ] **Step 2: Add fields to `PurchaseOrder` in `prisma/schema/payments.prisma`**

Open `prisma/schema/payments.prisma`, find `model PurchaseOrder` (starts line 31). After the `walletTransactionId` field (line 44), add:

```prisma
  appliedCoinOfferId  String?             @db.Uuid
  offerBonusCoinsAmount BigInt            @default(0)
```

After the `package             CoinPackage         @relation(fields: [packageId], references: [id])` line (line 58), add:

```prisma
  appliedCoinOffer    CoinOffer?          @relation(fields: [appliedCoinOfferId], references: [id], onDelete: SetNull)
```

- [ ] **Step 3: Generate migration SQL (create-only, don't apply yet)**

Run: `npx prisma migrate dev --create-only --name home_banners_and_coin_offers`

This writes a new folder under `prisma/schema/migrations/`. Expected: it creates `home_banners`, `coin_offers` tables, the two enums, and alters `purchase_orders` to add the two new columns + FK.

- [ ] **Step 4: Append the partial unique index to the generated migration.sql**

Open the newly created `prisma/schema/migrations/<timestamp>_home_banners_and_coin_offers/migration.sql` and append at the end:

```sql
-- At most one active CoinOffer per eligibility segment at a time.
CREATE UNIQUE INDEX "coin_offers_one_active_per_segment"
  ON "coin_offers" ("eligibility") WHERE "isActive" = true;
```

- [ ] **Step 5: Apply the migration and regenerate the client**

Run: `npx prisma migrate dev`
Expected: migration applies cleanly, `Prisma Client` regenerates. Verify with `npx prisma migrate status` — should report "Database schema is up to date!".

- [ ] **Step 6: Leave changes uncommitted**

Do not run `git add`/`git commit`. Leave the modified/new files as working-tree changes for the user to review and commit.

---

## Task 2: Backend — Coin Offer module (admin + public + purchase integration)

**Files:**
- Create: `src/modules/coin-offers/coin-offers.module.ts`
- Create: `src/modules/coin-offers/dto/coin-offer.dto.ts`
- Create: `src/modules/coin-offers/repositories/coin-offer.repository.ts`
- Create: `src/modules/coin-offers/services/coin-offer.service.ts`
- Create: `src/modules/coin-offers/controllers/coin-offer-admin.controller.ts`
- Create: `src/modules/coin-offers/controllers/coin-offer.controller.ts`
- Create: `src/modules/coin-offers/services/coin-offer.service.spec.ts`
- Modify: `src/modules/payments/services/purchase-order.service.ts`
- Modify: `src/modules/payments/payments.module.ts` (import `CoinOffersModule`)
- Modify: `src/app.module.ts` (register `CoinOffersModule`)

**Interfaces:**
- Consumes: `PrismaService` (`src/infra/prisma/prisma.service.ts`), `@RequireRoles`/`@RequirePermissions` decorators (`src/common/decorators/`), `AuditLogAction`/`AuditLogInterceptor` (grep `super-admin-purchase.controller.ts` for exact import paths), `CurrentUser` decorator for the authenticated user id in the public controller.
- Produces: `CoinOfferService.resolveEligibleOffer(userId: string): Promise<{ id: string; percentage: number } | null>` — consumed by `PurchaseOrderService` in this task and by nothing else yet.

- [ ] **Step 1: DTOs**

`src/modules/coin-offers/dto/coin-offer.dto.ts`:

```typescript
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { CoinOfferEligibility } from '@prisma/client';

export class CreateCoinOfferDto {
  @IsString()
  @MinLength(1)
  title!: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  percentage!: number;

  @IsEnum(CoinOfferEligibility)
  eligibility!: CoinOfferEligibility;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateCoinOfferDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  title?: string;

  @IsInt()
  @Min(1)
  @Max(1000)
  @IsOptional()
  percentage?: number;

  @IsEnum(CoinOfferEligibility)
  @IsOptional()
  eligibility?: CoinOfferEligibility;
}

export class CoinOfferResponseDto {
  id!: string;
  title!: string;
  percentage!: number;
  eligibility!: CoinOfferEligibility;
  isActive!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
```

- [ ] **Step 2: Repository**

`src/modules/coin-offers/repositories/coin-offer.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { CoinOfferEligibility, PurchaseOrderStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';

@Injectable()
export class CoinOfferRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateCoinOfferDto & { createdBy?: string }) {
    return this.prisma.coinOffer.create({ data });
  }

  update(id: string, data: UpdateCoinOfferDto) {
    return this.prisma.coinOffer.update({ where: { id }, data });
  }

  findById(id: string) {
    return this.prisma.coinOffer.findUnique({ where: { id } });
  }

  list() {
    return this.prisma.coinOffer.findMany({ orderBy: { createdAt: 'desc' } });
  }

  findActiveBySegment(eligibility: CoinOfferEligibility) {
    return this.prisma.coinOffer.findFirst({ where: { eligibility, isActive: true } });
  }

  /** Activates `id`, deactivating any other active offer in the same segment, atomically. */
  async activateExclusive(id: string, eligibility: CoinOfferEligibility) {
    return this.prisma.$transaction(async (tx) => {
      await tx.coinOffer.updateMany({
        where: { eligibility, isActive: true, id: { not: id } },
        data: { isActive: false },
      });
      return tx.coinOffer.update({ where: { id }, data: { isActive: true } });
    });
  }

  deactivate(id: string) {
    return this.prisma.coinOffer.update({ where: { id }, data: { isActive: false } });
  }

  hasCompletedPurchase(userId: string) {
    return this.prisma.purchaseOrder
      .count({ where: { userId, status: PurchaseOrderStatus.COMPLETED } })
      .then((count) => count > 0);
  }
}
```

- [ ] **Step 3: Service**

`src/modules/coin-offers/services/coin-offer.service.ts`:

```typescript
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CoinOfferEligibility } from '@prisma/client';
import { CoinOfferRepository } from '../repositories/coin-offer.repository';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';

@Injectable()
export class CoinOfferService {
  constructor(private readonly repo: CoinOfferRepository) {}

  list() {
    return this.repo.list();
  }

  async create(actorId: string, dto: CreateCoinOfferDto) {
    const offer = await this.repo.create({ ...dto, createdBy: actorId });
    if (dto.isActive !== false) {
      return this.repo.activateExclusive(offer.id, offer.eligibility);
    }
    return offer;
  }

  async update(id: string, dto: UpdateCoinOfferDto) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Coin offer not found');
    if (dto.percentage !== undefined && (dto.percentage < 1 || dto.percentage > 1000)) {
      throw new BadRequestException('percentage must be between 1 and 1000');
    }
    return this.repo.update(id, dto);
  }

  async toggle(id: string, isActive: boolean) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('Coin offer not found');
    if (!isActive) return this.repo.deactivate(id);
    return this.repo.activateExclusive(id, existing.eligibility);
  }

  /**
   * Resolves which offer (if any) the given user is eligible for right now.
   * Priority when both a segment-specific and an ALL_USERS offer are active
   * simultaneously: the segment-specific one wins (it's the more targeted
   * promotion).
   */
  async resolveEligibleOffer(userId: string): Promise<{ id: string; percentage: number } | null> {
    const hasCompleted = await this.repo.hasCompletedPurchase(userId);
    const segment: CoinOfferEligibility = hasCompleted
      ? CoinOfferEligibility.EXISTING_USERS_ONLY
      : CoinOfferEligibility.FIRST_PURCHASE_ONLY;

    const segmentOffer = await this.repo.findActiveBySegment(segment);
    if (segmentOffer) return { id: segmentOffer.id, percentage: segmentOffer.percentage };

    const allUsersOffer = await this.repo.findActiveBySegment(CoinOfferEligibility.ALL_USERS);
    if (allUsersOffer) return { id: allUsersOffer.id, percentage: allUsersOffer.percentage };

    return null;
  }
}
```

- [ ] **Step 4: Unit test for `resolveEligibleOffer` and `activateExclusive` priority**

`src/modules/coin-offers/services/coin-offer.service.spec.ts`:

```typescript
import { Test } from '@nestjs/testing';
import { CoinOfferEligibility } from '@prisma/client';
import { CoinOfferService } from './coin-offer.service';
import { CoinOfferRepository } from '../repositories/coin-offer.repository';

describe('CoinOfferService.resolveEligibleOffer', () => {
  let service: CoinOfferService;
  let repo: { hasCompletedPurchase: jest.Mock; findActiveBySegment: jest.Mock };

  beforeEach(async () => {
    repo = { hasCompletedPurchase: jest.fn(), findActiveBySegment: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [CoinOfferService, { provide: CoinOfferRepository, useValue: repo }],
    }).compile();
    service = moduleRef.get(CoinOfferService);
  });

  it('returns the FIRST_PURCHASE_ONLY offer for a user with no completed purchases', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(false);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) =>
      seg === CoinOfferEligibility.FIRST_PURCHASE_ONLY
        ? Promise.resolve({ id: 'offer-1', percentage: 10 })
        : Promise.resolve(null),
    );

    const result = await service.resolveEligibleOffer('user-1');

    expect(result).toEqual({ id: 'offer-1', percentage: 10 });
  });

  it('prefers the EXISTING_USERS_ONLY offer over an ALL_USERS offer for a repeat buyer', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(true);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) => {
      if (seg === CoinOfferEligibility.EXISTING_USERS_ONLY) return Promise.resolve({ id: 'offer-2', percentage: 5 });
      if (seg === CoinOfferEligibility.ALL_USERS) return Promise.resolve({ id: 'offer-3', percentage: 20 });
      return Promise.resolve(null);
    });

    const result = await service.resolveEligibleOffer('user-2');

    expect(result).toEqual({ id: 'offer-2', percentage: 5 });
  });

  it('falls back to ALL_USERS when no segment-specific offer is active', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(true);
    repo.findActiveBySegment.mockImplementation((seg: CoinOfferEligibility) =>
      seg === CoinOfferEligibility.ALL_USERS ? Promise.resolve({ id: 'offer-4', percentage: 15 }) : Promise.resolve(null),
    );

    const result = await service.resolveEligibleOffer('user-3');

    expect(result).toEqual({ id: 'offer-4', percentage: 15 });
  });

  it('returns null when no offer is active for the user at all', async () => {
    repo.hasCompletedPurchase.mockResolvedValue(false);
    repo.findActiveBySegment.mockResolvedValue(null);

    const result = await service.resolveEligibleOffer('user-4');

    expect(result).toBeNull();
  });
});
```

Run: `npx jest src/modules/coin-offers/services/coin-offer.service.spec.ts`
Expected: 4 passing tests.

- [ ] **Step 5: Admin controller**

First, check `src/modules/super-admin/controllers/super-admin-purchase.controller.ts` for the exact import paths of `RequireRoles`, `RequirePermissions`, `AuditLogAction`, `AuditLogInterceptor`, `JwtAuthGuard`, `RbacRolesGuard`, `RbacPermissionsGuard`, and `CurrentUser`, and copy them verbatim into the new controller (the paths may differ slightly from guesses below — use what that file actually imports).

`src/modules/coin-offers/controllers/coin-offer-admin.controller.ts`:

```typescript
import { Body, Controller, Get, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { CoinOfferService } from '../services/coin-offer.service';
import { CreateCoinOfferDto, UpdateCoinOfferDto } from '../dto/coin-offer.dto';
// Replace the four imports below with the exact paths found in
// super-admin-purchase.controller.ts.
import { RequireRoles } from 'src/common/decorators/require-roles.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { AuditLogAction } from 'src/common/decorators/audit-log-action.decorator';
import { AuditLogInterceptor } from 'src/common/interceptors/audit-log.interceptor';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';

@Controller('admin/coin-offers')
@RequireRoles('SUPER_ADMIN')
export class CoinOfferAdminController {
  constructor(private readonly service: CoinOfferService) {}

  @Get()
  @RequirePermissions('coin_offers.manage')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('coin_offer.create')
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateCoinOfferDto) {
    return this.service.create(actorId, dto);
  }

  @Put(':id')
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('coin_offer.update')
  update(@Param('id') id: string, @Body() dto: UpdateCoinOfferDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/toggle')
  @RequirePermissions('coin_offers.manage')
  @AuditLogAction('coin_offer.toggle')
  toggle(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.service.toggle(id, isActive);
  }
}
```

Note: if `AuditLogInterceptor` in the reference controller is applied via `@UseInterceptors(AuditLogInterceptor)` at class level rather than implied by the decorator, add that too — check the reference file.

- [ ] **Step 6: Public controller**

`src/modules/coin-offers/controllers/coin-offer.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { CoinOfferService } from '../services/coin-offer.service';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';

@Controller('coin-offers')
export class CoinOfferController {
  constructor(private readonly service: CoinOfferService) {}

  @Get('active')
  async active(@CurrentUser('id') userId: string) {
    return this.service.resolveEligibleOffer(userId);
  }
}
```

- [ ] **Step 7: Module**

`src/modules/coin-offers/coin-offers.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { CoinOfferService } from './services/coin-offer.service';
import { CoinOfferRepository } from './repositories/coin-offer.repository';
import { CoinOfferAdminController } from './controllers/coin-offer-admin.controller';
import { CoinOfferController } from './controllers/coin-offer.controller';

@Module({
  controllers: [CoinOfferAdminController, CoinOfferController],
  providers: [CoinOfferService, CoinOfferRepository],
  exports: [CoinOfferService],
})
export class CoinOffersModule {}
```

- [ ] **Step 8: Register the module**

In `src/app.module.ts`, add `CoinOffersModule` to the `imports` array (find where `WealthModule` or similar is imported and follow the same pattern).

- [ ] **Step 9: Wire into `PurchaseOrderService`**

Open `src/modules/payments/services/purchase-order.service.ts`. Add `CoinOfferService` to the constructor:

```typescript
import { CoinOfferService } from 'src/modules/coin-offers/services/coin-offer.service';

// in the constructor:
    private readonly coinOfferService: CoinOfferService,
```

Replace lines 38-39 (`const baseCoins = ...` / `const totalCoins = ...`) with:

```typescript
    const baseCoins = BigInt(pkg.coins);
    const bonusCoins = BigInt(pkg.bonusCoins);
    const offer = await this.coinOfferService.resolveEligibleOffer(userId);
    const offerBonusCoins = offer ? (baseCoins * BigInt(offer.percentage)) / 100n : 0n;
    const totalCoins = baseCoins + bonusCoins + offerBonusCoins;
```

In the `this.prisma.purchaseOrder.create({ data: { ... } })` call further down, add two fields alongside the existing `bonusCoinsAmount: bonusCoins,`:

```typescript
        appliedCoinOfferId: offer?.id ?? null,
        offerBonusCoinsAmount: offerBonusCoins,
```

- [ ] **Step 10: Import `CoinOffersModule` into `PaymentsModule`**

In `src/modules/payments/payments.module.ts`, add `CoinOffersModule` to `imports` (needed so `CoinOfferService` is injectable into `PurchaseOrderService`).

- [ ] **Step 11: Compile check**

Run: `npx tsc --noEmit`
Expected: no new errors introduced by this task. Fix any that reference wrong import paths for the RBAC/audit decorators (Step 5 note).

- [ ] **Step 12: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 3: Backend — Home Banner module

**Files:**
- Create: `src/modules/banners/banners.module.ts`
- Create: `src/modules/banners/dto/banner.dto.ts`
- Create: `src/modules/banners/repositories/banner.repository.ts`
- Create: `src/modules/banners/services/banner.service.ts`
- Create: `src/modules/banners/controllers/banner-admin.controller.ts`
- Create: `src/modules/banners/controllers/banner.controller.ts`
- Modify: `src/app.module.ts` (register `BannersModule`)

**Interfaces:**
- Consumes: `MediaUrlResolver` (`src/infra/storage/media-url.resolver.ts`) — same injection pattern as `wealth-admin.controller.ts`'s `this.media.resolve(...)`. Same RBAC/audit decorator imports as Task 2 Step 5.
- Produces: nothing consumed by other backend tasks (mobile/super-admin consume this over HTTP).

- [ ] **Step 1: DTOs**

`src/modules/banners/dto/banner.dto.ts`:

```typescript
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, IsUrl, MinLength, ValidateIf } from 'class-validator';
import { BannerRedirectPage } from '@prisma/client';

export class CreateBannerDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @MinLength(1)
  imageKey!: string;

  @IsEnum(BannerRedirectPage)
  redirectPage!: BannerRedirectPage;

  @ValidateIf((o) => o.redirectPage === BannerRedirectPage.AUDIO_ROOM)
  @IsUUID()
  redirectTargetId?: string;

  @ValidateIf((o) => o.redirectPage === BannerRedirectPage.EXTERNAL_URL)
  @IsUrl()
  externalUrl?: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class UpdateBannerDto {
  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @MinLength(1)
  @IsOptional()
  imageKey?: string;

  @IsEnum(BannerRedirectPage)
  @IsOptional()
  redirectPage?: BannerRedirectPage;

  @IsUUID()
  @IsOptional()
  redirectTargetId?: string;

  @IsUrl()
  @IsOptional()
  externalUrl?: string;

  @IsInt()
  @IsOptional()
  sortOrder?: number;
}

export class ReorderBannersDto {
  /** Ordered array of banner ids — index in the array becomes its sortOrder. */
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}
```

- [ ] **Step 2: Repository**

`src/modules/banners/repositories/banner.repository.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateBannerDto, UpdateBannerDto } from '../dto/banner.dto';

@Injectable()
export class BannerRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateBannerDto & { createdBy?: string }) {
    return this.prisma.homeBanner.create({ data });
  }

  update(id: string, data: UpdateBannerDto) {
    return this.prisma.homeBanner.update({ where: { id }, data });
  }

  findById(id: string) {
    return this.prisma.homeBanner.findUnique({ where: { id } });
  }

  list() {
    return this.prisma.homeBanner.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  listActive() {
    return this.prisma.homeBanner.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  toggle(id: string, isActive: boolean) {
    return this.prisma.homeBanner.update({ where: { id }, data: { isActive } });
  }

  async reorder(orderedIds: string[]) {
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.homeBanner.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
  }
}
```

- [ ] **Step 3: Service**

`src/modules/banners/services/banner.service.ts`:

```typescript
import { Injectable } from '@nestjs/common';
import { BannerRepository } from '../repositories/banner.repository';
import { CreateBannerDto, UpdateBannerDto } from '../dto/banner.dto';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

@Injectable()
export class BannerService {
  constructor(
    private readonly repo: BannerRepository,
    private readonly media: MediaUrlResolver,
  ) {}

  list() {
    return this.repo.list();
  }

  create(actorId: string, dto: CreateBannerDto) {
    return this.repo.create({ ...dto, createdBy: actorId });
  }

  update(id: string, dto: UpdateBannerDto) {
    return this.repo.update(id, dto);
  }

  toggle(id: string, isActive: boolean) {
    return this.repo.toggle(id, isActive);
  }

  reorder(orderedIds: string[]) {
    return this.repo.reorder(orderedIds);
  }

  async listActiveForApp() {
    const banners = await this.repo.listActive();
    return Promise.all(
      banners.map(async (b) => ({
        id: b.id,
        title: b.title,
        imageUrl: await this.media.resolve(b.imageKey),
        redirectPage: b.redirectPage,
        redirectTargetId: b.redirectTargetId,
        externalUrl: b.externalUrl,
        sortOrder: b.sortOrder,
      })),
    );
  }
}
```

- [ ] **Step 4: Admin controller**

`src/modules/banners/controllers/banner-admin.controller.ts` (same RBAC/audit import notes as Task 2 Step 5 apply):

```typescript
import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { BannerService } from '../services/banner.service';
import { CreateBannerDto, UpdateBannerDto, ReorderBannersDto } from '../dto/banner.dto';
import { RequireRoles } from 'src/common/decorators/require-roles.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { AuditLogAction } from 'src/common/decorators/audit-log-action.decorator';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';

@Controller('admin/banners')
@RequireRoles('SUPER_ADMIN')
export class BannerAdminController {
  constructor(private readonly service: BannerService) {}

  @Get()
  @RequirePermissions('banners.manage')
  list() {
    return this.service.list();
  }

  @Post()
  @RequirePermissions('banners.manage')
  @AuditLogAction('banner.create')
  create(@CurrentUser('id') actorId: string, @Body() dto: CreateBannerDto) {
    return this.service.create(actorId, dto);
  }

  @Put(':id')
  @RequirePermissions('banners.manage')
  @AuditLogAction('banner.update')
  update(@Param('id') id: string, @Body() dto: UpdateBannerDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/toggle')
  @RequirePermissions('banners.manage')
  @AuditLogAction('banner.toggle')
  toggle(@Param('id') id: string, @Body('isActive') isActive: boolean) {
    return this.service.toggle(id, isActive);
  }

  @Patch('reorder')
  @RequirePermissions('banners.manage')
  @AuditLogAction('banner.reorder')
  reorder(@Body() dto: ReorderBannersDto) {
    return this.service.reorder(dto.orderedIds);
  }
}
```

- [ ] **Step 5: Public controller**

`src/modules/banners/controllers/banner.controller.ts`:

```typescript
import { Controller, Get } from '@nestjs/common';
import { BannerService } from '../services/banner.service';

@Controller('banners')
export class BannerController {
  constructor(private readonly service: BannerService) {}

  @Get('active')
  active() {
    return this.service.listActiveForApp();
  }
}
```

- [ ] **Step 6: Module**

`src/modules/banners/banners.module.ts`:

```typescript
import { Module } from '@nestjs/common';
import { BannerService } from './services/banner.service';
import { BannerRepository } from './repositories/banner.repository';
import { BannerAdminController } from './controllers/banner-admin.controller';
import { BannerController } from './controllers/banner.controller';

@Module({
  controllers: [BannerAdminController, BannerController],
  providers: [BannerService, BannerRepository],
})
export class BannersModule {}
```

Check how `MediaUrlResolver` is provided to other modules (e.g. `WealthModule`) — it may need to come from an imported `StorageModule`. Grep `wealth.module.ts` for how it gets `MediaUrlResolver` and mirror that in `imports`.

- [ ] **Step 7: Register the module**

In `src/app.module.ts`, add `BannersModule` to `imports`.

- [ ] **Step 8: Compile check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 9: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 4: Backend — RBAC permission seeding

**Files:**
- Modify: whichever file seeds `rbac.prisma`'s permission rows (locate it first — grep `prisma/schema/rbac.prisma` model names like `Permission` in `prisma/seed-rbac.ts` or similar, per the earlier audit's file listing of `prisma/seed-rbac.ts`).

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `banners.manage` and `coin_offers.manage` permission rows that Task 2/3's `@RequirePermissions(...)` decorators check against.

- [ ] **Step 1: Locate the permission seed list**

Run: `grep -n "wealth.manage" prisma/seed-rbac.ts` (or wherever it's actually defined — adjust path if this misses) to find the array/list of permission strings that gets seeded.

- [ ] **Step 2: Add the two new permission strings**

Add `'banners.manage'` and `'coin_offers.manage'` to that same list/array, following the exact object shape neighboring entries use (likely `{ name, description, category }` or similar — copy the `wealth.manage` entry's shape exactly).

- [ ] **Step 3: Run the seed**

Run: `npx ts-node prisma/seed-rbac.ts` (or whatever script command `package.json` defines for it — check `package.json`'s `scripts` block for a `seed:rbac` or similar entry and use that instead if present).
Expected: script completes without error; the two new permissions exist in the `permissions` table (spot check: `SELECT name FROM permissions WHERE name IN ('banners.manage','coin_offers.manage');` should return both rows).

- [ ] **Step 4: Grant the permissions to the SUPER_ADMIN role**

Check how `wealth.manage` gets attached to the `SUPER_ADMIN` role (likely the same seed script links permissions to a default role) — ensure the new two permissions are included in whatever mapping grants `SUPER_ADMIN` its permission set. If the seed script auto-grants all permissions to `SUPER_ADMIN`, no extra step is needed; if it's an explicit list, add the two new strings there too.

- [ ] **Step 5: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 5: Super Admin — Coin Offer Management screen

**Files:**
- Create: `packages/shared/src/modules/CoinOfferManagementModule.tsx`
- Modify: `packages/shared/src/api/endpoints.ts` (add `superAdmin.coinOffers` namespace)
- Modify: `packages/shared/src/index.ts` (export the new component)
- Modify: `apps/superadmin/src/App.tsx` (nav entry + render)
- Modify: `packages/shared/src/ui/Shell.tsx` (sidebar icon case)

**Interfaces:**
- Consumes: `useResource`, `DataTable`, `Panel`, `Badge`, `Grid` from `ui/primitives` (exact import paths — copy from `FinancialModule.tsx`'s imports), `ApiClient` via `endpoints.superAdmin.coinOffers.*`.
- Produces: nothing consumed elsewhere in this repo.

- [ ] **Step 1: Read the reference implementation**

Open `packages/shared/src/modules/FinancialModule.tsx` around line 464 (`CoinPackagesScreen`) in full, and note: the exact `useResource` call shape, the modal overlay JSX structure, the form-field `useState` pattern, and the save/cancel button wiring. This task's component copies that shape with different fields.

- [ ] **Step 2: Add API endpoints**

In `packages/shared/src/api/endpoints.ts`, find the `superAdmin.purchases` namespace (used by `CoinPackagesScreen`) and add a sibling `coinOffers` namespace with the same shape:

```typescript
coinOffers: {
  list: () => api.get('/admin/coin-offers'),
  create: (data: CreateCoinOfferPayload) => api.post('/admin/coin-offers', data),
  update: (id: string, data: UpdateCoinOfferPayload) => api.put(`/admin/coin-offers/${id}`, data),
  toggle: (id: string, isActive: boolean) => api.patch(`/admin/coin-offers/${id}/toggle`, { isActive }),
},
```

Match the exact `api.get/post/put/patch` call signature used by the neighboring `purchases` namespace (it may differ from this sketch — copy its pattern exactly, including how the base client is referenced).

Add matching TypeScript types (`CreateCoinOfferPayload`, `UpdateCoinOfferPayload`, `CoinOfferEligibility` as a union type `'FIRST_PURCHASE_ONLY' | 'EXISTING_USERS_ONLY' | 'ALL_USERS'`) near wherever `CoinPackage`'s types live in this file.

- [ ] **Step 3: Build the screen component**

`packages/shared/src/modules/CoinOfferManagementModule.tsx` — copy `CoinPackagesScreen`'s full structure (imports, `useResource` call, modal state, table rendering) and adapt:

- List columns: Title, Percentage, Eligibility (rendered with the "First Coin Purchase Only" / "Existing Users Only" / "All Users" display labels — map `FIRST_PURCHASE_ONLY` → "First Coin Purchase Only" explicitly, do not show the raw enum string), Active (`Badge`), Created.
- Form fields: `title` (text input), `percentage` (number input, min 1 max 1000), `eligibility` (`<select>` with the three options, display-labeled as above), `isActive` (toggle).
- On toggling `isActive` to `true` for an offer, before calling the API, check the current list for another offer with the same `eligibility` that has `isActive === true`; if found, show a `window.confirm`-style inline warning ("This will deactivate '<title>' — continue?") before proceeding — copy however `FinancialModule.tsx` handles any existing destructive-confirmation pattern if one exists there, otherwise use a plain `window.confirm(...)`.
- Export the component as `export function CoinOfferManagementModule()`.

- [ ] **Step 4: Export from the shared barrel**

In `packages/shared/src/index.ts`, add `export { CoinOfferManagementModule } from './modules/CoinOfferManagementModule';` alongside the existing module exports.

- [ ] **Step 5: Wire into navigation**

In `apps/superadmin/src/App.tsx`:
- Add an entry to the `GROUPS` array (find the `'ADDITIONAL MODULES'` group or equivalent) with `id: 'coin-offers'`, `label: 'Coin Offers'`, `permission: 'coin_offers.manage'` (match the exact field names neighboring entries use).
- In the JSX body where `{current === 'financial' && <FinancialModule />}`-style conditionals live, add `{current === 'coin-offers' && <CoinOfferManagementModule />}`.

In `packages/shared/src/ui/Shell.tsx`, find `getSidebarIcon()` (around line 32) and add a `case 'coin-offers':` returning a reasonable icon (reuse an existing SVG case, e.g. copy whatever icon `'financial'` or `'purchases'` uses, or a coin/percentage icon if one already exists in that switch).

- [ ] **Step 6: Manual verification**

Run: `pnpm --filter apps/superadmin dev` (or whatever the repo's actual dev script is — check `package.json`), open the dashboard, log in as an account with `coin_offers.manage`, navigate to the new "Coin Offers" nav item, create an `ALL_USERS` offer at 10%, confirm it lists and the toggle works, then create a `FIRST_PURCHASE_ONLY` offer and confirm activating it does not silently break the `ALL_USERS` one (different segments coexist).

- [ ] **Step 7: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 6: Super Admin — Banner Management screen

**Files:**
- Create: `packages/shared/src/modules/BannerManagementModule.tsx`
- Modify: `packages/shared/src/api/endpoints.ts` (add `superAdmin.banners` namespace)
- Modify: `packages/shared/src/index.ts` (export the new component)
- Modify: `apps/superadmin/src/App.tsx` (nav entry + render)
- Modify: `packages/shared/src/ui/Shell.tsx` (sidebar icon case)

**Interfaces:**
- Consumes: same primitives as Task 5, plus the presign-upload pattern from `WealthLevelModule.tsx`'s `uploadWealthAsset` (around line 143).
- Produces: nothing consumed elsewhere in this repo.

- [ ] **Step 1: Read the reference upload implementation**

Open `packages/shared/src/modules/WealthLevelModule.tsx` around lines 143-150 (`uploadWealthAsset`) in full — note the exact presign call (`endpoints.superAdmin.wealth.presignUpload(...)`), the PUT-to-S3 step, and how the returned `key` gets stored into form state.

- [ ] **Step 2: Add API endpoints**

In `packages/shared/src/api/endpoints.ts`, add a `banners` namespace sibling to `coinOffers` (added in Task 5):

```typescript
banners: {
  list: () => api.get('/admin/banners'),
  create: (data: CreateBannerPayload) => api.post('/admin/banners', data),
  update: (id: string, data: UpdateBannerPayload) => api.put(`/admin/banners/${id}`, data),
  toggle: (id: string, isActive: boolean) => api.patch(`/admin/banners/${id}/toggle`, { isActive }),
  reorder: (orderedIds: string[]) => api.patch('/admin/banners/reorder', { orderedIds }),
},
```

Reuse the existing generic presign endpoint already wired at `endpoints.ts:923-924` (`POST /storage/presign`) — do not add a banner-specific upload endpoint, per the spec.

Add `CreateBannerPayload`/`UpdateBannerPayload` types, with `redirectPage` typed as the union `'HOME' | 'COINS' | 'VIP' | 'EVENTS' | 'WALLET' | 'AUDIO_ROOM' | 'EXTERNAL_URL'`.

- [ ] **Step 3: Build the screen component**

`packages/shared/src/modules/BannerManagementModule.tsx` — copy `CoinPackagesScreen`'s structure again, adapted:

- List columns: Thumbnail (small `<img>` using `api.resolveMediaUrl` on the stored key, or the resolved `imageUrl` if the list endpoint already returns one — check what `GET /admin/banners` actually returns per Task 3 and use that), Title, Redirect target (human label), Order, Active.
- Form fields: `title` (text, optional), image upload button (using the presign pattern from Step 1 — store `imageKey` in form state, show a preview), `redirectPage` (`<select>` with the 7 enum values, human-labeled, e.g. "Audio Room" for `AUDIO_ROOM`), a conditional `redirectTargetId` UUID text input shown only when `redirectPage === 'AUDIO_ROOM'`, a conditional `externalUrl` text input shown only when `redirectPage === 'EXTERNAL_URL'`, `isActive` toggle.
- Reordering: simple up/down arrow buttons per row (no drag-and-drop library available in this codebase per the audit) that swap `sortOrder` with the neighboring row and call `endpoints.superAdmin.banners.reorder(newOrderedIds)` with the full reordered id list.
- Export as `export function BannerManagementModule()`.

- [ ] **Step 4: Export from the shared barrel**

In `packages/shared/src/index.ts`, add `export { BannerManagementModule } from './modules/BannerManagementModule';`.

- [ ] **Step 5: Wire into navigation**

Same pattern as Task 5 Step 5: add a `GROUPS` entry (`id: 'banners'`, `label: 'Home Banners'`, `permission: 'banners.manage'`) and a render conditional in `App.tsx`, plus an icon case (`case 'banners':`) in `Shell.tsx`.

- [ ] **Step 6: Manual verification**

With the dev server running, create a banner with an uploaded image and `redirectPage = AUDIO_ROOM` + a real audio room id, confirm it appears in the list with the correct thumbnail, toggle it inactive, and use the up/down buttons to confirm reordering persists after a page refresh.

- [ ] **Step 7: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 7: Mobile — Home banner carousel

**Files:**
- Create: `lib/features/home/data/datasources/home_banner_remote_data_source.dart`
- Create: `lib/features/home/domain/entities/home_banner.dart`
- Create: `lib/features/home/domain/repositories/home_banner_repository.dart`
- Create: `lib/features/home/data/repositories/home_banner_repository_impl.dart`
- Create: `lib/features/home/presentation/providers/home_banner_provider.dart`
- Modify: `lib/features/home/presentation/widgets/event_banner_carousel.dart` (generalize to accept generic items)
- Modify: `lib/features/home/presentation/screens/home_screen.dart` (wire the carousel into `_HomeHeader`)
- Modify: `lib/core/constants/api_endpoints.dart` (add the banners endpoint)

**Interfaces:**
- Consumes: `DioClient`, `ResponseParser` (exact classes used by `CoinPackageRemoteDataSource` — read that file first for the precise pattern), `ApiResult<T>` type.
- Produces: `HomeBanner` entity `{id, title, imageUrl, redirectPage, redirectTargetId, externalUrl, sortOrder}`; `homeBannersProvider` (Riverpod) exposing `AsyncValue<List<HomeBanner>>`.

- [ ] **Step 1: Read the reference data source**

Open `lib/features/wallet/data/datasources/coin_package_remote_data_source.dart` (or wherever `CoinPackageRemoteDataSource` actually lives — locate via the earlier exploration's note) in full to copy its exact `_dio.get(...)` + `ResponseParser.parseList<T>(...)` pattern.

- [ ] **Step 2: Add the endpoint constant**

In `lib/core/constants/api_endpoints.dart`, add:

```dart
static const String activeBanners = '/banners/active';
```

next to the existing package/wallet endpoint constants (match the neighboring naming convention exactly).

- [ ] **Step 3: Entity**

`lib/features/home/domain/entities/home_banner.dart`:

```dart
enum BannerRedirectPage { home, coins, vip, events, wallet, audioRoom, externalUrl }

BannerRedirectPage bannerRedirectPageFromString(String value) {
  switch (value) {
    case 'HOME':
      return BannerRedirectPage.home;
    case 'COINS':
      return BannerRedirectPage.coins;
    case 'VIP':
      return BannerRedirectPage.vip;
    case 'EVENTS':
      return BannerRedirectPage.events;
    case 'WALLET':
      return BannerRedirectPage.wallet;
    case 'AUDIO_ROOM':
      return BannerRedirectPage.audioRoom;
    case 'EXTERNAL_URL':
      return BannerRedirectPage.externalUrl;
    default:
      throw ArgumentError('Unknown BannerRedirectPage: $value');
  }
}

class HomeBanner {
  final String id;
  final String? title;
  final String imageUrl;
  final BannerRedirectPage redirectPage;
  final String? redirectTargetId;
  final String? externalUrl;
  final int sortOrder;

  const HomeBanner({
    required this.id,
    required this.title,
    required this.imageUrl,
    required this.redirectPage,
    required this.redirectTargetId,
    required this.externalUrl,
    required this.sortOrder,
  });

  factory HomeBanner.fromJson(Map<String, dynamic> json) {
    return HomeBanner(
      id: json['id'] as String,
      title: json['title'] as String?,
      imageUrl: json['imageUrl'] as String,
      redirectPage: bannerRedirectPageFromString(json['redirectPage'] as String),
      redirectTargetId: json['redirectTargetId'] as String?,
      externalUrl: json['externalUrl'] as String?,
      sortOrder: json['sortOrder'] as int,
    );
  }
}
```

- [ ] **Step 4: Data source**

`lib/features/home/data/datasources/home_banner_remote_data_source.dart` — copy `CoinPackageRemoteDataSource`'s exact constructor-injection and error-handling shape (its actual code, read in Step 1), targeting `ApiEndpoints.activeBanners` and parsing into `List<HomeBanner>` via `HomeBanner.fromJson`.

- [ ] **Step 5: Repository + provider**

`lib/features/home/domain/repositories/home_banner_repository.dart`:

```dart
import 'package:soulzaa/core/network/api_result.dart'; // adjust import to actual ApiResult location
import '../entities/home_banner.dart';

abstract class HomeBannerRepository {
  Future<ApiResult<List<HomeBanner>>> activeBanners();
}
```

`lib/features/home/data/repositories/home_banner_repository_impl.dart` implements it by delegating to the data source, matching whatever error-mapping convention `CoinPackageRepository`'s impl uses (read that file too if the shape isn't obvious from the data source alone).

`lib/features/home/presentation/providers/home_banner_provider.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../domain/entities/home_banner.dart';
// import the repository provider following this app's existing DI wiring convention (Riverpod Provider composing DioClient -> DataSource -> Repository, mirroring however coinPackagesControllerProvider is wired)

final homeBannersProvider = FutureProvider<List<HomeBanner>>((ref) async {
  final repo = ref.watch(homeBannerRepositoryProvider); // define homeBannerRepositoryProvider alongside this, mirroring the wallet feature's provider wiring
  final result = await repo.activeBanners();
  return result.when(
    success: (data) => data,
    failure: (_) => <HomeBanner>[],
  );
});
```

Adjust the `ApiResult.when`/`success`/`failure` call to match this codebase's actual `ApiResult` API (read its definition before writing this file).

- [ ] **Step 6: Generalize `EventBannerCarousel`**

Open `lib/features/home/presentation/widgets/event_banner_carousel.dart` in full. It's currently typed to `PlatformEvent`. Change its item type to a small generic slide model so both events and home banners can use it without duplicating the carousel:

```dart
class CarouselSlide {
  final String imageUrl;
  final VoidCallback onTap;
  const CarouselSlide({required this.imageUrl, required this.onTap});
}
```

Update `EventBannerCarousel`'s constructor to take `List<CarouselSlide> slides` instead of `List<PlatformEvent> events`, and update its internal `PageView.builder`/dot-indicator logic to read `slides[index].imageUrl` and call `slides[index].onTap` on tap, preserving the existing auto-scroll timer and infinite-loop indexing logic untouched. Update any existing call site that constructs `EventBannerCarousel` with `events:` to instead map its events into `CarouselSlide` objects inline at the call site.

- [ ] **Step 7: Wire into `_HomeHeader`**

Open `lib/features/home/presentation/screens/home_screen.dart`, find `_HomeHeader` and the static `Image.asset('assets/images/home_talent_show_banner.png')`. Replace it with a `Consumer` (or extend `_HomeHeader` to a `ConsumerWidget` if it isn't already) that watches `homeBannersProvider` and renders `EventBannerCarousel(slides: banners.map((b) => CarouselSlide(imageUrl: b.imageUrl, onTap: () => _handleBannerTap(context, b))).toList())` when the list is non-empty, falling back to the original static asset image when the list is empty or still loading (so the header never renders blank).

Add a `_handleBannerTap` function in the same file:

```dart
void _handleBannerTap(BuildContext context, HomeBanner banner) {
  switch (banner.redirectPage) {
    case BannerRedirectPage.home:
      context.go(RoutePaths.home);
      break;
    case BannerRedirectPage.coins:
      context.push(RoutePaths.coins, extra: true); // true = arrivedViaBanner, consumed in Task 8
      break;
    case BannerRedirectPage.vip:
      context.push(RoutePaths.vip);
      break;
    case BannerRedirectPage.events:
      context.push(RoutePaths.events);
      break;
    case BannerRedirectPage.wallet:
      context.push(RoutePaths.wallet);
      break;
    case BannerRedirectPage.audioRoom:
      if (banner.redirectTargetId != null) {
        context.push(RoutePaths.audioRoomDetail(banner.redirectTargetId!));
      }
      break;
    case BannerRedirectPage.externalUrl:
      if (banner.externalUrl != null) {
        // Check for an existing in-app webview route/package in this codebase
        // (grep for "WebView" or "webview_flutter" in pubspec.yaml and lib/)
        // before adding a new dependency; wire it here once found.
      }
      break;
  }
}
```

- [ ] **Step 8: Manual verification**

Run the app (`flutter run`), confirm the Home Screen shows the static fallback banner when the backend has zero active banners, then create one via the Super Admin UI (Task 6) and confirm it appears and is tappable, routing correctly for at least the `COINS` and `AUDIO_ROOM` cases.

- [ ] **Step 9: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Task 8: Mobile — Coin offer badge + flower-bomb splash on Buy Coins screen

**Files:**
- Create: `lib/features/wallet/data/datasources/coin_offer_remote_data_source.dart`
- Create: `lib/features/wallet/domain/entities/coin_offer.dart`
- Create: `lib/features/wallet/presentation/providers/coin_offer_provider.dart`
- Modify: `lib/features/wallet/presentation/screens/buy_coins_screen.dart`
- Modify: `lib/core/constants/api_endpoints.dart` (add the offer endpoint)
- Modify: `lib/core/routing/route_paths.dart` and wherever the `coins` route is declared in `app_router.dart` (accept the `extra: bool arrivedViaBanner` parameter)

**Interfaces:**
- Consumes: `HomeBanner`'s tap handler passes `extra: true` on `context.push(RoutePaths.coins, extra: true)` (Task 7 Step 7) — this task reads that `extra` value on the destination route.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Endpoint constant**

In `lib/core/constants/api_endpoints.dart`, add:

```dart
static const String activeCoinOffer = '/coin-offers/active';
```

- [ ] **Step 2: Entity**

`lib/features/wallet/domain/entities/coin_offer.dart`:

```dart
class CoinOffer {
  final String id;
  final int percentage;

  const CoinOffer({required this.id, required this.percentage});

  factory CoinOffer.fromJson(Map<String, dynamic> json) {
    return CoinOffer(id: json['id'] as String, percentage: json['percentage'] as int);
  }
}
```

- [ ] **Step 3: Data source + provider**

`lib/features/wallet/data/datasources/coin_offer_remote_data_source.dart` — same shape as `CoinPackageRemoteDataSource` (Task 7 Step 1 reference), but the endpoint returns either a JSON object or `null`; handle the null case by returning `null` from the data source rather than throwing.

`lib/features/wallet/presentation/providers/coin_offer_provider.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../domain/entities/coin_offer.dart';

final coinOfferProvider = FutureProvider<CoinOffer?>((ref) async {
  final dataSource = ref.watch(coinOfferRemoteDataSourceProvider); // define alongside, mirroring existing wallet DI wiring
  return dataSource.activeOffer();
});
```

- [ ] **Step 4: Route param for `arrivedViaBanner`**

Open `lib/core/routing/app_router.dart`, find the route builder for `RoutePaths.coins` (the `BuyCoinsScreen` route). Add a `bool arrivedViaBanner = (state.extra as bool?) ?? false;` read inside the builder and pass it as a constructor parameter to `BuyCoinsScreen`, e.g. `BuyCoinsScreen(arrivedViaBanner: arrivedViaBanner)`. Update `BuyCoinsScreen`'s constructor in `buy_coins_screen.dart` to accept `final bool arrivedViaBanner;` (default `false`).

- [ ] **Step 5: Badge on `_PackageTile`**

Open `lib/features/wallet/presentation/screens/buy_coins_screen.dart`, locate `_PackageTile` (around line 369, the existing `if (package.hasBonus) ...` block). Above the `GridView.builder` in the parent widget, watch `coinOfferProvider`:

```dart
final offerAsync = ref.watch(coinOfferProvider);
final offer = offerAsync.valueOrNull;
```

Pass `offer` down into `_PackageTile` and add a `Positioned` ribbon (or extend the existing bonus-text row) rendering `'+${offer.percentage}% Extra'` when `offer != null`, using the same text style as the existing bonus label for visual consistency.

- [ ] **Step 6: Flower-bomb splash on arrival**

In `buy_coins_screen.dart`'s `State`/`ConsumerState` `initState` (or a `ref.listen` one-shot effect if the screen is fully declarative), when `widget.arrivedViaBanner == true` and `coinOfferProvider` resolves to a non-null offer, trigger a one-shot overlay:

```dart
if (widget.arrivedViaBanner) {
  ref.listen<AsyncValue<CoinOffer?>>(coinOfferProvider, (previous, next) {
    final offer = next.valueOrNull;
    if (offer != null && previous?.valueOrNull == null) {
      _showOfferSplash(offer.percentage);
    }
  });
}
```

```dart
void _showOfferSplash(int percentage) {
  showGeneralDialog(
    context: context,
    barrierColor: Colors.transparent,
    barrierDismissible: true,
    pageBuilder: (_, __, ___) => Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Lottie.asset('assets/animations/flower_bomb.json', repeat: false, width: 240, height: 240),
          const SizedBox(height: 12),
          Text(
            '$percentage% offer applied!',
            style: Theme.of(context).textTheme.titleLarge?.copyWith(fontWeight: FontWeight.bold),
          ),
        ],
      ),
    ),
  );
  Future.delayed(const Duration(seconds: 2), () {
    if (mounted) Navigator.of(context).maybePop();
  });
}
```

Note: `assets/animations/flower_bomb.json` does not exist yet — this step requires an actual Lottie animation asset. **Flag to the user before this step**: either they supply a "flower bomb" Lottie JSON file to place at that path, or a placeholder confetti-style public-domain Lottie animation is substituted temporarily (search existing `assets/animations/` for any existing celebratory animation already bundled — e.g. gift animations mentioned in the earlier mobile audit — and reuse one of those instead of blocking on a new asset). Register the new asset path in `pubspec.yaml`'s `flutter: assets:` list if it isn't already covered by a directory glob.

- [ ] **Step 7: Manual verification**

As a user with zero completed purchases, with a `FIRST_PURCHASE_ONLY` offer active (created in Task 5's verification), tap a Home banner pointed at `COINS`, confirm the splash plays once and the badge shows on package tiles, complete a purchase, confirm the credited amount includes the offer bonus, then reopen the Coins screen (not via a banner) and confirm no splash replays and the badge is gone (now an existing-user).

- [ ] **Step 8: Leave changes uncommitted**

Do not run `git add`/`git commit`.

---

## Self-Review Notes

- **Spec coverage:** Data model → Task 1. Backend CoinOffer CRUD + purchase integration → Task 2. Backend Banner CRUD → Task 3. RBAC permissions (implied by spec's admin-gating requirement) → Task 4. Super Admin Coin Offer UI → Task 5. Super Admin Banner UI → Task 6. Mobile banner carousel → Task 7. Mobile offer badge + splash → Task 8. All spec sections have a task.
- **Known gap requiring a user decision before Task 8 Step 6 can be finished as written:** no "flower bomb" Lottie asset exists in the repo. The step flags this inline rather than inventing a fake path.
- **Type consistency:** `resolveEligibleOffer` return shape (`{id, percentage} | null`) is defined once in Task 2 and consumed identically in Task 2's `PurchaseOrderService` wiring and Task 2's public controller — no drift. `BannerRedirectPage` string values (`HOME`, `COINS`, ..., `AUDIO_ROOM`, `EXTERNAL_URL`) are defined in Task 1's Prisma enum and referenced identically in Task 3 (backend DTO), Task 6 (super admin select options), and Task 7 (mobile enum mapping) — checked for spelling consistency across all four.
