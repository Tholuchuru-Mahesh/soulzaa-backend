# Home Banners & Coin Offers — Design Spec

Date: 2026-09-04
Repos touched: `soulzaa-backend`, `soulzaa-superadmins`, `soulzaa-mobile`

## Goal

Two Super-Admin-controlled features:
1. **Home Banner Management** — image banners on the Mobile Home Screen, orderable, activatable, with a redirect destination.
2. **Coin Offer Management** — percentage-based bonus-coin promotions targeted at NEW/EXISTING/ALL users, auto-applied during real coin purchases.

## Decisions (confirmed with user)

- **Banner redirect**: static pages, or a specific Audio Room by id, or an external URL (in-app webview). `EVENTS`/`VIDEO_ROOM` detail deep-links are **not** wired yet on mobile (no such route exists today) — enum is extensible later without a migration change to callers.
- **"New user" definition**: a user with **zero `PurchaseOrder` rows that ever reached `COMPLETED`**, decided by the backend at purchase time — never account-creation age. Labeled **"First Coin Purchase Only"** in all UI copy. A later refund does not retroactively restore eligibility (the purchase did complete once).
- **Offer scope**: one active offer's percentage applies to whichever package the eligible user buys — no per-package restriction.
- **Concurrency**: at most one active `CoinOffer` per `eligibility` segment at a time. Activating one auto-deactivates any other active offer in the same segment (service-layer) backed by a partial unique index (DB-layer race guard).
- **Bonus timing**: the offer's bonus is computed and locked into the `PurchaseOrder` row at **order-creation** time (mirrors exactly how `package.bonusCoins` already works) — not recomputed at fulfillment. An admin deactivating the offer mid-flight cannot claw back a bonus the user already locked in.

## 1. Data Model

New file `prisma/schema/promotions.prisma`:

```prisma
enum BannerRedirectPage {
  HOME
  COINS
  VIP
  EVENTS
  WALLET
  AUDIO_ROOM     // requires redirectTargetId
  EXTERNAL_URL   // requires externalUrl
}

model HomeBanner {
  id               String             @id @default(uuid()) @db.Uuid
  title            String?
  imageKey         String
  redirectPage     BannerRedirectPage
  redirectTargetId String?            @db.Uuid
  externalUrl      String?
  isActive         Boolean            @default(true)
  sortOrder        Int                @default(0)
  createdBy        String?            @db.Uuid
  createdAt        DateTime           @default(now())
  updatedAt        DateTime           @updatedAt

  @@index([isActive, sortOrder])
  @@map("home_banners")
}

enum CoinOfferEligibility {
  FIRST_PURCHASE_ONLY
  EXISTING_USERS_ONLY
  ALL_USERS
}

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

Migration also adds, via raw SQL in the same migration file (partial unique index isn't expressible in `schema.prisma` syntax):
```sql
CREATE UNIQUE INDEX "coin_offers_one_active_per_segment"
  ON "coin_offers" ("eligibility") WHERE "isActive" = true;
```

`prisma/schema/payments.prisma` — additive fields on `PurchaseOrder`:
```prisma
appliedCoinOfferId    String?    @db.Uuid
offerBonusCoinsAmount BigInt     @default(0)
appliedCoinOffer      CoinOffer? @relation(fields: [appliedCoinOfferId], references: [id], onDelete: SetNull)
```
`totalCoins` becomes `coinsAmount + bonusCoinsAmount + offerBonusCoinsAmount`.

## 2. Backend

### Modules
Two new modules under `src/modules/`, following the `wealth` module shape:
- `src/modules/banners/` — `controllers/banner-admin.controller.ts` (Super-Admin CRUD), `controllers/banner.controller.ts` (public, read-only, mobile-facing), `services/banner.service.ts`, `repositories/banner.repository.ts`, `dto/banner.dto.ts`, `banners.module.ts`.
- `src/modules/coin-offers/` — same shape: `coin-offer-admin.controller.ts`, `coin-offer.controller.ts` (public — "what offer am I eligible for right now"), `coin-offer.service.ts`, `coin-offer.repository.ts`, `dto/coin-offer.dto.ts`, `coin-offers.module.ts`.

### Auth
Both admin controllers follow `super-admin-purchase.controller.ts`'s pattern: `@RequireRoles('SUPER_ADMIN')` at class level, `@RequirePermissions('banners.manage')` / `@RequirePermissions('coin_offers.manage')` per mutating method, `@AuditLogAction(...)` + `AuditLogInterceptor` on create/update/delete/toggle. New permission strings need to be seeded in `prisma/schema/migrations/*` RBAC seed data (check `rbac.prisma` seed convention) or via the existing permissions-seed script.

### Endpoints

**Banners (admin)** — `POST/GET/PUT/PATCH /admin/banners`, `PATCH /admin/banners/:id/reorder` (bulk sortOrder update), `PATCH /admin/banners/:id/toggle`. Image upload reuses the existing generic `/storage/presign` → client PUT → `/storage/confirm` flow (no new upload endpoint needed); the client sends the resulting `imageKey` on create/update.

**Banners (public)** — `GET /banners/active` → `HomeBanner[]` where `isActive = true`, ordered by `sortOrder`, `imageKey` resolved to a real URL via `MediaUrlResolver` before returning.

**Coin Offers (admin)** — `POST/GET/PUT /admin/coin-offers`, `PATCH /admin/coin-offers/:id/toggle` (this is where segment-uniqueness is enforced: activating deactivates the segment's previous active row, in a `$transaction`).

**Coin Offers (public)** — `GET /coin-offers/active` → resolves the current user's eligible offer (evaluates `FIRST_PURCHASE_ONLY`/`EXISTING_USERS_ONLY`/`ALL_USERS` against their purchase history server-side) or `null`. This is what the Buy Coins screen calls to decide whether to show the "10% Extra" badge *before* the user commits to a purchase — it must **not** just echo back "an offer is active", it evaluates eligibility for the calling user.

### Purchase integration (`purchase-order.service.ts`)

At `createPurchaseOrder`, right after `baseCoins`/`bonusCoins` are computed (`purchase-order.service.ts:38-39`), insert:
```ts
const offer = await this.coinOfferService.resolveEligibleOffer(userId);
const offerBonusCoins = offer ? (baseCoins * BigInt(offer.percentage)) / 100n : 0n;
const totalCoins = baseCoins + bonusCoins + offerBonusCoins;
```
and add `appliedCoinOfferId: offer?.id ?? null, offerBonusCoinsAmount: offerBonusCoins` to the `create()` call. `resolveEligibleOffer` does the `FIRST_PURCHASE_ONLY` check via `prisma.purchaseOrder.count({ where: { userId, status: 'COMPLETED' } }) === 0`, falling through segment priority: a `FIRST_PURCHASE_ONLY`/`EXISTING_USERS_ONLY` active offer (whichever matches the user) takes priority over an `ALL_USERS` one if both happen to be active (they're independent segments, so both *can* be simultaneously active) — that resolution order needs to be explicit and tested since it's the one place two active rows can legitimately coexist.

No change needed to `ReceiptVerificationService`/`WalletTransactionService.creditWallet()` — they already just credit whatever `totalCoins` the order was created with.

## 3. Super Admin (`soulzaa-superadmins`)

Two new screen components in `packages/shared/src/modules/`: `BannerManagementModule.tsx`, `CoinOfferManagementModule.tsx`, following `CoinPackagesScreen`'s exact shape (`useResource` for list, plain `useState` form fields, manual modal overlay, `DataTable`/`Panel`/`Badge`/`Grid` primitives — no new form library).

- **Banner form**: title, image upload (copy `WealthLevelModule`'s `uploadWealthAsset` presign→PUT→store-key pattern), redirect-page dropdown (`BannerRedirectPage` enum values), conditional target-id / external-URL field shown based on the selected redirect page, `isActive` toggle, drag-or-arrow-button reordering writing `sortOrder`.
- **Coin Offer form**: title, percentage (number input), eligibility dropdown (`FIRST_PURCHASE_ONLY` labeled "First Coin Purchase Only" / `EXISTING_USERS_ONLY` / `ALL_USERS`), `isActive` toggle — toggling on shows a confirmation if another offer is already active in that segment ("This will deactivate '<other offer title>' — continue?"), since the backend will silently do that swap otherwise.
- **Nav wiring**: add two entries to `GROUPS` in `App.tsx` (e.g. under `ADDITIONAL MODULES`), gated by the new `banners.manage`/`coin_offers.manage` permissions, plus icon cases in `Shell.tsx#getSidebarIcon()`; export both components from `packages/shared/src/index.ts`.
- New `endpoints.ts` entries under a `superAdmin.banners` / `superAdmin.coinOffers` namespace, mirroring `superAdmin.purchases`.

## 4. Mobile (`soulzaa-mobile`)

### Home banner carousel
`EventBannerCarousel` (`lib/features/home/presentation/widgets/event_banner_carousel.dart`) already exists, fully built, and is currently unused. New work is a parallel data path, not a new widget: a `homeBannersProvider` (Riverpod) backed by a new `HomeBannerRemoteDataSource` (`GET /banners/active`, same Dio/`ApiResult` shape as `CoinPackageRemoteDataSource`), fed into either a copy of `EventBannerCarousel` retyped for `HomeBanner`, or (preferred, less duplication) a small generalization of `EventBannerCarousel` to accept `{imageUrl, onTap}` items instead of being hard-typed to `PlatformEvent`. Wired into `_HomeHeader` in `home_screen.dart`, replacing the single static `Image.asset` banner.

Tap handling maps `redirectPage` → route:
```dart
switch (banner.redirectPage) {
  case BannerRedirectPage.home: context.go(RoutePaths.home);
  case BannerRedirectPage.coins: context.push(RoutePaths.coins, extra: offerAppliedFlag);
  case BannerRedirectPage.vip: context.push(RoutePaths.vip);
  case BannerRedirectPage.events: context.push(RoutePaths.events);
  case BannerRedirectPage.wallet: context.push(RoutePaths.wallet);
  case BannerRedirectPage.audioRoom: context.push(RoutePaths.audioRoomDetail(banner.redirectTargetId!));
  case BannerRedirectPage.externalUrl: // in-app webview (check for an existing WebView route/package first)
}
```

### Buy Coins screen offer badge + splash
`buy_coins_screen.dart` gains a `coinOfferProvider` (Riverpod) calling `GET /coin-offers/active`. If non-null, `_PackageTile` renders a badge (reusing the existing bonus-text slot pattern at line ~369) reading e.g. "+10% Extra". On successful purchase, `totalCoins` returned by the order already includes the offer bonus — no separate confirmation step needed for the *badge*.

**Flower-bomb splash** (new requirement, arrival-triggered): when the Coins screen is opened **via a banner tap** (not organically) **and** an offer is currently eligible for this user, play a celebratory animation + "`<percentage>`% offer applied!" banner text on screen entry. Implementation: reuse the already-present `lottie: ^3.3.1` dependency (no new package) — drop in a "flower bomb" Lottie JSON asset, play once via a `Lottie.asset(..., repeat: false)` overlay triggered from `initState`/a one-shot Riverpod listener, gated on an `arrivedViaBanner` flag passed through `context.push(RoutePaths.coins, extra: true)` from the carousel's tap handler. This is a genuinely visual asset choice (exact animation look) — flagging that if you want to review animation options visually rather than just from this text description, I can open the visual companion for it before implementation.

## 5. Testing / Verification

No automated test suite run requested for this feature (per your standing "don't test, don't waste time" instruction) — verification is the manual flow already listed in your original doc: create banner → appears on Home → tap routes correctly → deactivate → disappears. Create `FIRST_PURCHASE_ONLY` 10% offer → new user sees badge + splash + gets bonus on purchase → same user no longer sees badge/bonus after that purchase completes.

I will still write unit tests for the two new backend services (`CoinOfferService.resolveEligibleOffer`, the segment-uniqueness toggle logic) as part of implementation, per this repo's existing TDD convention (`superpowers:test-driven-development`), unless told otherwise — that's about correctness of money-bearing logic, distinct from the "don't waste time running full suites" instruction.

## Open follow-ups (not blocking)

- `EVENTS`/video-room deep-link redirect targets aren't wired on mobile yet (no such detail route exists) — `BannerRedirectPage` is deliberately left extensible for when they are.
- RBAC permission strings (`banners.manage`, `coin_offers.manage`) need adding to whatever seeds `rbac.prisma`'s permission table — implementation step, not a design question.
