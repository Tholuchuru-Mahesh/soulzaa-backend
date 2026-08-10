# Coin In-App Purchase (Google Play Billing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user buy Soul Coins through Google Play Billing, with the backend independently verifying each purchase against the Play Developer API before crediting the wallet, and automatically clawing coins back when Play reports a refund.

**Architecture:** The Flutter client opens a `PurchaseOrder` on the backend, launches the Play billing sheet, then posts the resulting purchase token back for verification. The backend calls `purchases.products.get`, asserts the purchase matches the order it claims to settle, credits the wallet through the existing double-entry ledger, and only then consumes the purchase with Play. A Pub/Sub push webhook receives Play's voided-purchase notifications and reverses the credit.

**Tech Stack:** NestJS + Prisma + PostgreSQL (backend), Flutter + Riverpod + Dio (mobile), `google-auth-library@^10.9.0` (already installed), `in_app_purchase` (new mobile dependency).

**Spec:** `docs/superpowers/specs/2026-08-04-coin-in-app-purchase-design.md`

## Global Constraints

- **Never run `git commit`.** This repository's owner stages and commits their own work. Every task ends with a **Checkpoint** step: stop, report what changed, and let the user review. Do not commit, amend, or push.
- **Backend repo:** `/Users/nasinaudaysankar/Downloads/soulzaa-backend`. **Mobile repo:** `/Users/nasinaudaysankar/Downloads/soulzaa-mobile`. Tasks state which.
- **Backend tests:** `pnpm test -- <path>`. Jest picks up `*.spec.ts` under `src`. **Lint:** `pnpm lint` must pass with `--max-warnings 0`.
- **Mobile tests:** `flutter test <path>`. **Analyze:** `flutter analyze` must be clean.
- **Mobile code generation is unavailable.** `build_runner` cannot run (dart_style is too old for the pinned Dart SDK). Every new model and entity is hand-written. Do not add `@freezed`, `part` directives, or `.g.dart` imports to new files.
- **Fail closed.** No payment adapter may report `isVerified: true` unless it actually verified something. An unconfigured provider, a network error, and a malformed payload all return `isVerified: false`.
- **Play product IDs are lowercase.** Valid characters: `a-z`, `0-9`, `_`, `.`; must start with a lowercase letter or digit. The nine tiers are `in_gold_100`, `in_gold_200`, `in_gold_500`, `in_gold_1000`, `in_gold_2000`, `in_gold_5000`, `in_gold_10000`, `in_gold_20000`, `in_gold_40000`.
- **Coin amounts are `BigInt` in Prisma** and are serialised to JSON as **strings**. Never send them as JSON numbers.
- **Existing behaviour to preserve:** `src/modules/payments/adapters/fail-closed.spec.ts` and `src/modules/payments/services/coin-purchase.spec.ts` must keep passing, except where a task explicitly rewrites a case.

---

## File Structure

**Backend — created:**

| File | Responsibility |
|---|---|
| `src/modules/payments/adapters/google-play-api.client.ts` | Sole owner of HTTP calls to the Android Publisher API. Auth, URLs, error shaping. Nothing about orders or wallets. |
| `src/modules/payments/controllers/google-rtdn.controller.ts` | Pub/Sub push endpoint. Token verification and envelope decoding only. |
| `src/modules/payments/services/google-rtdn.service.ts` | Interprets a decoded notification and drives the reversal. |
| `src/modules/payments/dto/google-rtdn.dto.ts` | Pub/Sub push envelope shape. |

**Backend — modified:**

| File | Change |
|---|---|
| `prisma/schema/payments.prisma` | `googleProductId`, `appleProductId` on `CoinPackage`. |
| `prisma/schema/wallet.prisma` | `PURCHASE_REVERSAL` in `WalletTxnReason`. |
| `src/config/env.validation.ts`, `src/config/configuration.ts` | Three new payment env vars; retire `GOOGLE_PLAY_LICENSE_KEY`. |
| `src/modules/payments/adapters/payment-provider.interface.ts` | Extra optional fields on `VerificationResult`. |
| `src/modules/payments/adapters/google-play.adapter.ts` | Rewritten to use the API client. |
| `src/modules/payments/services/receipt-verification.service.ts` | Five assertions, then consume after credit. |
| `src/modules/payments/services/coin-package.service.ts` | Expose `googleProductId`. |
| `src/modules/payments/dto/coin-package.dto.ts` | Accept `googleProductId` on create/update. |
| `src/modules/payments/controllers/coin-purchase.controller.ts` | Order-ownership fixes. |
| `src/modules/payments/services/purchase-query.service.ts` | Ownership-scoped `getOrderDetails`. |
| `src/modules/payments/payments.module.ts` | Register new providers and controller. |
| `src/modules/wallet/services/wallet-transaction.service.ts` | `reverseWallet()`. |

**Mobile — created:**

| File | Responsibility |
|---|---|
| `lib/features/wallet/data/datasources/iap_platform.dart` | Thin interface over the `in_app_purchase` plugin, so purchase logic is testable without the platform channel. |
| `lib/features/wallet/data/datasources/coin_purchase_remote_data_source.dart` | `POST /payments/orders` and `POST /payments/verify`. |
| `lib/features/wallet/data/datasources/pending_order_store.dart` | Persists `productId → orderId` across an app kill. |
| `lib/features/wallet/domain/entities/purchase_order.dart` | Order returned by `POST /payments/orders`. |
| `lib/features/wallet/data/models/purchase_order_model.dart` | Hand-written JSON mapper for the above. |
| `lib/features/wallet/presentation/controllers/coin_purchase_controller.dart` | Drives the buy flow and owns the purchase-stream subscription. |

**Mobile — modified:**

| File | Change |
|---|---|
| `pubspec.yaml` | Add `in_app_purchase`. |
| `lib/features/wallet/domain/entities/coin_package.dart` | `googleProductId` field. |
| `lib/features/wallet/data/models/coin_package_model.dart` | Parse `googleProductId`. |
| `lib/features/wallet/presentation/screens/buy_coins_screen.dart` | Real checkout in `_onPressed`; store prices. |
| `lib/app.dart` | Keep the purchase-stream subscription alive session-wide. |

---

## Task 1: Store product IDs on coin packages

**Repo:** backend

**Files:**
- Modify: `prisma/schema/payments.prisma:26-47`
- Modify: `prisma/schema/wallet.prisma:75-109`
- Modify: `src/modules/payments/services/coin-package.service.ts`
- Modify: `src/modules/payments/dto/coin-package.dto.ts`
- Test: `src/modules/payments/services/coin-package-store-id.spec.ts` (create)

**Interfaces:**
- Produces: `CoinPackage.googleProductId: string | null` on every package row and on every `/payments/packages` response object. `WalletTxnReason.PURCHASE_REVERSAL`. Tasks 3, 4, 5 and 7 all depend on these.

- [ ] **Step 1: Write the failing test**

Create `src/modules/payments/services/coin-package-store-id.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CoinPackageService } from './coin-package.service';
import { PurchaseAuditService } from './purchase-audit.service';

/**
 * The catalogue is the only place the client learns which Play SKU maps to which
 * bundle. A package that reaches the app without its product ID cannot be bought,
 * so this is asserted rather than assumed.
 */
describe('CoinPackageService store product IDs', () => {
  let service: CoinPackageService;

  const mockPrisma: any = {
    coinPackage: { findMany: jest.fn(), findFirst: jest.fn() },
    purchaseAudit: { create: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ locationCountry: { code: 'IN' } }) },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoinPackageService,
        PurchaseAuditService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(CoinPackageService);
    jest.clearAllMocks();
  });

  it('exposes googleProductId on listed packages', async () => {
    mockPrisma.coinPackage.findMany.mockResolvedValue([
      {
        id: 'pkg-1',
        code: 'IN_GOLD_100',
        name: '250 Coins',
        coins: 250n,
        bonusCoins: 0n,
        priceAmount: 100,
        currency: 'INR',
        country: 'IN',
        platform: 'ALL',
        googleProductId: 'in_gold_100',
        appleProductId: null,
        isActive: true,
        sortOrder: 0,
      },
    ]);

    const result = await service.listPackages({}, 'user-1');

    expect(result[0].googleProductId).toBe('in_gold_100');
    // BigInt fields must stay strings on the wire.
    expect(result[0].coins).toBe('250');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/services/coin-package-store-id.spec.ts`
Expected: FAIL — `result[0].googleProductId` is `undefined` because the column does not exist.

- [ ] **Step 3: Add the schema columns**

In `prisma/schema/payments.prisma`, inside `model CoinPackage`, immediately after the `platform` line:

```prisma
  /// Google Play in-app product ID. Play requires lowercase `[a-z0-9_.]`, so this
  /// cannot reuse `code` (`IN_GOLD_100`). Null means the package is not sellable
  /// on Android and the client hides it.
  googleProductId String?  @unique
  /// App Store product ID. Null until the iOS spec lands.
  appleProductId  String?  @unique
```

In `prisma/schema/wallet.prisma`, inside `enum WalletTxnReason`, after `ADMIN_DEBIT`:

```prisma
  /// Coins reversed because Play voided the purchase that created them. Kept
  /// distinct from ADMIN_DEBIT so refund losses are separable in reporting.
  PURCHASE_REVERSAL
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm prisma:migrate --name add_store_product_ids_and_purchase_reversal`

Expected: a new directory under `prisma/migrations/` and `prisma generate` running automatically. If the dev database is unreachable, run `pnpm prisma:generate` so the client types update, and note that the migration must be created before merge.

- [ ] **Step 5: Backfill the product IDs**

Create `scripts/backfill-google-product-ids.ts`, modelled on the existing `scripts/seed-coin-packages-inr.ts` (same `--apply` guard, same dry-run-by-default behaviour):

```ts
/**
 * Fills `googleProductId` for the INR tiers.
 *
 * Play product IDs are lowercase-only, so `IN_GOLD_100` cannot be reused as-is.
 * The mapping is a straight lowercase of `code`, which is what the Play Console
 * products are named.
 *
 * Dry-run by default; pass --apply to write.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const packages = await prisma.coinPackage.findMany({
    where: { googleProductId: null },
    select: { id: true, code: true },
  });

  for (const pkg of packages) {
    const productId = pkg.code.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.]*$/.test(productId)) {
      throw new Error(`Code '${pkg.code}' does not lowercase into a valid Play product ID`);
    }
    console.log(`${apply ? 'SET' : 'WOULD SET'} ${pkg.code} -> ${productId}`);
    if (apply) {
      await prisma.coinPackage.update({
        where: { id: pkg.id },
        data: { googleProductId: productId },
      });
    }
  }

  console.log(`${packages.length} package(s) ${apply ? 'updated' : 'pending'}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

- [ ] **Step 6: Expose the field in the service response**

In `src/modules/payments/services/coin-package.service.ts`, the `listPackages` return already spreads the row (`...p`), so `googleProductId` flows through once the column exists. Confirm the same is true of `getPackageById` — read the method and, if it selects explicit fields rather than spreading, add `googleProductId` and `appleProductId` to that selection.

- [ ] **Step 7: Accept the field in the admin DTOs**

In `src/modules/payments/dto/coin-package.dto.ts`, add to `CreateCoinPackageDto` and `UpdateCoinPackageDto`:

```ts
  @ApiPropertyOptional({
    description: 'Google Play product ID (lowercase a-z, 0-9, _ and . only)',
    example: 'in_gold_100',
  })
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_.]*$/, {
    message: 'googleProductId must be lowercase and contain only a-z, 0-9, _ and .',
  })
  @IsOptional()
  googleProductId?: string;
```

Add `Matches` to the `class-validator` import list at the top of the file.

- [ ] **Step 8: Run the test to verify it passes**

Run: `pnpm test -- src/modules/payments/services/coin-package-store-id.spec.ts`
Expected: PASS

- [ ] **Step 9: Run the existing payments suite and lint**

Run: `pnpm test -- src/modules/payments && pnpm lint`
Expected: all PASS, zero lint warnings.

- [ ] **Step 10: Checkpoint**

Stop. Report: schema columns added, migration name, backfill script path, and the fact that the backfill has **not** been run against production. Do not commit.

---

## Task 2: Play Developer API client

**Repo:** backend

**Files:**
- Create: `src/modules/payments/adapters/google-play-api.client.ts`
- Modify: `src/config/env.validation.ts:117-125`
- Modify: `src/config/configuration.ts:199-206`
- Modify: `src/modules/payments/payments.module.ts`
- Test: `src/modules/payments/adapters/google-play-api.client.spec.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface ProductPurchase {
    orderId?: string;
    productId?: string;
    purchaseState?: number;      // 0 purchased, 1 cancelled, 2 pending
    consumptionState?: number;   // 0 yet to be consumed, 1 consumed
    acknowledgementState?: number;
    obfuscatedExternalAccountId?: string;
    regionCode?: string;
  }

  class GooglePlayApiClient {
    isConfigured(): boolean;
    getProductPurchase(productId: string, purchaseToken: string): Promise<ProductPurchase>;
    consumeProductPurchase(productId: string, purchaseToken: string): Promise<void>;
  }
  ```
  Task 3 consumes `getProductPurchase`; Task 4 consumes `consumeProductPurchase`.

- [ ] **Step 1: Write the failing test**

Create `src/modules/payments/adapters/google-play-api.client.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { GooglePlayApiClient } from './google-play-api.client';

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'play@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

const configWith = (payments: Record<string, unknown>) =>
  ({ get: () => payments }) as unknown as ConfigService;

describe('GooglePlayApiClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports itself unconfigured when the service account is missing', () => {
    const client = new GooglePlayApiClient(
      configWith({ googlePlayPackageName: 'com.soulzaa.app' }),
    );

    expect(client.isConfigured()).toBe(false);
  });

  it('reports itself unconfigured when the package name is missing', () => {
    const client = new GooglePlayApiClient(
      configWith({ googlePlayServiceAccountJson: SERVICE_ACCOUNT }),
    );

    expect(client.isConfigured()).toBe(false);
  });

  it('requests the product purchase at the documented URL', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: SERVICE_ACCOUNT,
      }),
    );
    const request = jest
      .fn()
      .mockResolvedValue({ data: { orderId: 'GPA.1', productId: 'in_gold_100', purchaseState: 0 } });
    jest.spyOn(client as any, 'authClient').mockReturnValue({ request });

    const result = await client.getProductPurchase('in_gold_100', 'tok-1');

    expect(request).toHaveBeenCalledWith({
      url:
        'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        'com.soulzaa.app/purchases/products/in_gold_100/tokens/tok-1',
      method: 'GET',
    });
    expect(result.orderId).toBe('GPA.1');
  });

  it('posts to the :consume endpoint when consuming', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: SERVICE_ACCOUNT,
      }),
    );
    const request = jest.fn().mockResolvedValue({ data: {} });
    jest.spyOn(client as any, 'authClient').mockReturnValue({ request });

    await client.consumeProductPurchase('in_gold_100', 'tok-1');

    expect(request).toHaveBeenCalledWith({
      url:
        'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        'com.soulzaa.app/purchases/products/in_gold_100/tokens/tok-1:consume',
      method: 'POST',
    });
  });

  it('throws when asked to call the API unconfigured', async () => {
    const client = new GooglePlayApiClient(configWith({}));

    await expect(client.getProductPurchase('in_gold_100', 'tok-1')).rejects.toThrow(
      /not configured/i,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/adapters/google-play-api.client.spec.ts`
Expected: FAIL — `Cannot find module './google-play-api.client'`.

- [ ] **Step 3: Add the configuration**

In `src/config/env.validation.ts`, replace the `GOOGLE_PLAY_LICENSE_KEY` entry and its comment with:

```ts
  // Android applicationId of the published app, e.g. `com.soulzaa.app`. Part of
  // every Android Publisher API URL.
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  // Service-account credentials JSON with Android Publisher access, as a single
  // string. Used to mint the OAuth token for purchase verification.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  // Expected `aud` when verifying the OIDC token on a Pub/Sub push. Without it
  // the RTDN webhook rejects every delivery rather than trusting the caller.
  GOOGLE_RTDN_PUSH_AUDIENCE: z.string().optional(),
```

In `src/config/configuration.ts`, replace `googlePlayLicenseKey` inside `paymentsConfig`:

```ts
  googlePlayPackageName: env().GOOGLE_PLAY_PACKAGE_NAME,
  googlePlayServiceAccountJson: env().GOOGLE_PLAY_SERVICE_ACCOUNT_JSON,
  googleRtdnPushAudience: env().GOOGLE_RTDN_PUSH_AUDIENCE,
```

- [ ] **Step 4: Write the client**

Create `src/modules/payments/adapters/google-play-api.client.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JWT } from 'google-auth-library';

const API_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Subset of the Android Publisher ProductPurchase resource this codebase reads. */
export interface ProductPurchase {
  orderId?: string;
  productId?: string;
  /** 0 = purchased, 1 = cancelled, 2 = pending. */
  purchaseState?: number;
  /** 0 = yet to be consumed, 1 = consumed. */
  consumptionState?: number;
  acknowledgementState?: number;
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
}

/**
 * The only place that talks to the Android Publisher API.
 *
 * Kept separate from the adapter so that "how do we reach Google" and "is this
 * purchase allowed to settle this order" stay independently testable, and so the
 * verification path and the consume path share one authenticated client.
 */
@Injectable()
export class GooglePlayApiClient {
  private readonly logger = new Logger(GooglePlayApiClient.name);
  private cachedClient?: JWT;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const payments = this.config.get('payments', { infer: true });
    return Boolean(payments?.googlePlayPackageName && payments?.googlePlayServiceAccountJson);
  }

  async getProductPurchase(productId: string, purchaseToken: string): Promise<ProductPurchase> {
    const response = await this.authClient().request<ProductPurchase>({
      url: `${this.baseUrl(productId, purchaseToken)}`,
      method: 'GET',
    });
    return response.data;
  }

  async consumeProductPurchase(productId: string, purchaseToken: string): Promise<void> {
    await this.authClient().request({
      url: `${this.baseUrl(productId, purchaseToken)}:consume`,
      method: 'POST',
    });
  }

  private baseUrl(productId: string, purchaseToken: string): string {
    const packageName = this.config.get('payments', { infer: true })?.googlePlayPackageName;
    return `${API_ROOT}/${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`;
  }

  /**
   * Built lazily and cached: constructing the JWT parses the service-account key,
   * which must not happen at module load in environments that have no credentials.
   */
  private authClient(): JWT {
    if (this.cachedClient) return this.cachedClient;

    if (!this.isConfigured()) {
      throw new Error('Google Play API is not configured (package name or service account missing)');
    }

    const raw = this.config.get('payments', { infer: true })!.googlePlayServiceAccountJson as string;
    let credentials: { client_email?: string; private_key?: string };
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
    }

    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
    }

    this.cachedClient = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [SCOPE],
    });
    this.logger.log('Google Play API client initialised');
    return this.cachedClient;
  }
}
```

- [ ] **Step 5: Register the provider**

In `src/modules/payments/payments.module.ts`, import `GooglePlayApiClient` and add it to both `providers` and `exports`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test -- src/modules/payments/adapters/google-play-api.client.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Lint**

Run: `pnpm lint`
Expected: zero warnings.

- [ ] **Step 8: Checkpoint**

Stop. Report the new env vars the user must add to `.env.production`, and that `GOOGLE_PLAY_LICENSE_KEY` is now unused. Do not commit.

---

## Task 3: Rewrite the Google Play adapter

**Repo:** backend

**Files:**
- Modify: `src/modules/payments/adapters/payment-provider.interface.ts`
- Modify: `src/modules/payments/adapters/google-play.adapter.ts` (full rewrite)
- Modify: `src/modules/payments/adapters/fail-closed.spec.ts:19-64` (replace the `GooglePlayAdapter` describe block)

**Interfaces:**
- Consumes: `GooglePlayApiClient.getProductPurchase` (Task 2).
- Produces: `VerificationResult` with `productId`, `purchaseState`, `consumptionState`, `externalAccountId` populated. Task 4 asserts on all four.

- [ ] **Step 1: Extend the result interface**

In `src/modules/payments/adapters/payment-provider.interface.ts`, add to `VerificationResult` (all optional, so the other adapters compile untouched):

```ts
  /** Store product ID the purchase was actually for. Checked against the order's package. */
  productId?: string;
  /** Provider purchase state. Google: 0 purchased, 1 cancelled, 2 pending. */
  purchaseState?: number;
  /** Provider consumption state. Google: 0 yet to be consumed, 1 consumed. */
  consumptionState?: number;
  /** Account the purchase was bound to at checkout. Checked against the order's user. */
  externalAccountId?: string;
```

- [ ] **Step 2: Write the failing test**

Replace the entire `describe('GooglePlayAdapter', ...)` block in `src/modules/payments/adapters/fail-closed.spec.ts` with:

```ts
  describe('GooglePlayAdapter', () => {
    const configuredClient = (purchase: Record<string, unknown>) =>
      ({
        isConfigured: () => true,
        getProductPurchase: jest.fn().mockResolvedValue(purchase),
      }) as any;

    it('surfaces the fields the verification service asserts on', async () => {
      const adapter = new GooglePlayAdapter(
        configuredClient({
          orderId: 'GPA.1234',
          productId: 'in_gold_100',
          purchaseState: 0,
          consumptionState: 0,
          obfuscatedExternalAccountId: 'user-1',
        }),
      );

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(true);
      expect(result.providerTxnId).toBe('GPA.1234');
      expect(result.productId).toBe('in_gold_100');
      expect(result.purchaseState).toBe(0);
      expect(result.consumptionState).toBe(0);
      expect(result.externalAccountId).toBe('user-1');
    });

    it('rejects when unconfigured', async () => {
      const adapter = new GooglePlayAdapter({
        isConfigured: () => false,
        getProductPurchase: jest.fn(),
      } as any);

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/not configured/i);
    });

    it('rejects when Google returns an error rather than falling through to success', async () => {
      const adapter = new GooglePlayAdapter({
        isConfigured: () => true,
        getProductPurchase: jest.fn().mockRejectedValue(new Error('HTTP 410 token expired')),
      } as any);

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/410/);
    });

    it('rejects a response with no orderId', async () => {
      const adapter = new GooglePlayAdapter(
        configuredClient({ productId: 'in_gold_100', purchaseState: 0 }),
      );

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/orderId/i);
    });
  });
```

Delete the now-unused `generateKeyPairSync` / `createSign` imports and the `licenseKey`, `purchase` and `sign` bindings from the top of that file if nothing else references them. Keep the `order` constant and the `configWith` helper — the Apple and mock describes still use them.

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/adapters/fail-closed.spec.ts`
Expected: FAIL — `GooglePlayAdapter` still takes a `ConfigService` and has no `productId` in its result.

- [ ] **Step 4: Rewrite the adapter**

Replace the whole of `src/modules/payments/adapters/google-play.adapter.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { GooglePlayApiClient } from './google-play-api.client';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

/**
 * Google Play purchase verification via the Android Publisher API.
 *
 * This replaced an offline signature check against the Play licence key. A
 * signature proves the purchase JSON came from Google, but says nothing about
 * whether the purchase was later refunded, is still pending, or has already been
 * consumed — all of which the API reports. The signature path was removed rather
 * than kept as a fallback: a fallback that approves purchases the API would
 * reject is a hole, not a safety net.
 *
 * `receiptData` carries the Play purchase token. `signature` is unused here.
 */
@Injectable()
export class GooglePlayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(GooglePlayAdapter.name);

  constructor(private readonly apiClient: GooglePlayApiClient) {}

  async verifyReceipt(
    receiptData: string,
    _signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    if (!this.apiClient.isConfigured()) {
      // Fail closed: an unconfigured provider must never approve a purchase.
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage:
          'Google Play is not configured (GOOGLE_PLAY_PACKAGE_NAME or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON missing)',
      };
    }

    const productId = order?.package?.googleProductId;
    if (!productId) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Order package has no googleProductId; it cannot be sold on Android',
      };
    }

    try {
      const purchase = await this.apiClient.getProductPurchase(productId, receiptData);

      if (!purchase.orderId) {
        return {
          isVerified: false,
          providerTxnId: '',
          errorMessage: 'Google Play response is missing orderId',
        };
      }

      return {
        isVerified: true,
        providerTxnId: purchase.orderId,
        productId: purchase.productId,
        purchaseState: purchase.purchaseState,
        consumptionState: purchase.consumptionState,
        externalAccountId: purchase.obfuscatedExternalAccountId,
        amountVerified: order ? Number(order.priceAmount) : undefined,
        currencyVerified: order?.currency,
        rawPayload: { provider: 'GOOGLE_PLAY', ...purchase },
      };
    } catch (err) {
      // A network or API failure is not a valid purchase — never fall through.
      const message = (err as Error).message;
      this.logger.error(`Google Play verification failed for order '${order?.orderNumber}': ${message}`);
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: `Google Play verification failed: ${message}`,
      };
    }
  }
}
```

- [ ] **Step 5: Fix the other test that constructs the adapter**

`src/modules/payments/services/coin-purchase.spec.ts` builds a Nest testing module listing `GooglePlayAdapter` as a provider. Add `GooglePlayApiClient` to that provider list so Nest can resolve the new constructor dependency:

```ts
        { provide: GooglePlayApiClient, useValue: { isConfigured: () => false, getProductPurchase: jest.fn(), consumeProductPurchase: jest.fn() } },
```

Import `GooglePlayApiClient` from `../adapters/google-play-api.client` at the top of that file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- src/modules/payments`
Expected: PASS across the module.

- [ ] **Step 7: Lint**

Run: `pnpm lint`
Expected: zero warnings.

- [ ] **Step 8: Checkpoint**

Stop and report. Do not commit.

---

## Task 4: Verification assertions and consume-after-credit

**Repo:** backend

**Files:**
- Modify: `src/modules/payments/services/receipt-verification.service.ts`
- Test: `src/modules/payments/services/receipt-verification-guards.spec.ts` (create)

**Interfaces:**
- Consumes: `VerificationResult.{productId,purchaseState,consumptionState,externalAccountId}` (Task 3), `GooglePlayApiClient.consumeProductPurchase` (Task 2), `CoinPackage.googleProductId` (Task 1).
- Produces: `verifyAndFulfillPurchase(dto: VerifyPurchaseDto, callerId: string)` — `callerId` is now **required and enforced**, not just audited.

- [ ] **Step 1: Write the failing test**

Create `src/modules/payments/services/receipt-verification-guards.spec.ts`:

```ts
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { ReceiptVerificationService } from './receipt-verification.service';

/**
 * Every assertion here is a way a valid receipt could settle an order it has no
 * business settling. Each test asserts the wallet was NOT credited — a rejection
 * that still credits is the failure mode that matters.
 */
describe('ReceiptVerificationService guards', () => {
  const ORDER = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'user-1',
    provider: PaymentProvider.GOOGLE_PLAY,
    status: PurchaseOrderStatus.CREATED,
    totalCoins: '250',
    priceAmount: 100,
    currency: 'INR',
    package: { id: 'pkg-1', googleProductId: 'in_gold_100' },
  };

  const GOOD_RESULT = {
    isVerified: true,
    providerTxnId: 'GPA.1',
    productId: 'in_gold_100',
    purchaseState: 0,
    consumptionState: 0,
    externalAccountId: 'user-1',
  };

  let creditWallet: jest.Mock;
  let consumeProductPurchase: jest.Mock;
  let verifyReceipt: jest.Mock;
  let service: ReceiptVerificationService;

  const build = (order: any = ORDER) => {
    creditWallet = jest.fn().mockResolvedValue({ transactionId: 'tx-1' });
    consumeProductPurchase = jest.fn().mockResolvedValue(undefined);
    verifyReceipt = jest.fn().mockResolvedValue(GOOD_RESULT);

    const prisma: any = {
      paymentReceipt: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({ id: 'rcpt-1' }) },
    };
    const orderService: any = {
      getOrderById: jest.fn().mockResolvedValue(order),
      updateOrderStatus: jest.fn().mockResolvedValue({ ...order, status: PurchaseOrderStatus.COMPLETED, completedAt: new Date() }),
    };

    return new ReceiptVerificationService(
      prisma,
      orderService,
      { getAdapter: () => ({ verifyReceipt }) } as any,
      { creditWallet } as any,
      { isEconomyFrozen: jest.fn().mockResolvedValue(false) } as any,
      { validatePolicyLimit: jest.fn().mockResolvedValue(true) } as any,
      { logAudit: jest.fn() } as any,
      { consumeProductPurchase } as any,
    );
  };

  const dto = { orderId: 'order-1', receiptData: 'tok-1' };

  it('credits and then consumes on a clean purchase', async () => {
    service = build();

    const result = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(result.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);
    expect(consumeProductPurchase).toHaveBeenCalledWith('in_gold_100', 'tok-1');
    // Consume must run after the credit, never before.
    expect(creditWallet.mock.invocationCallOrder[0]).toBeLessThan(
      consumeProductPurchase.mock.invocationCallOrder[0],
    );
  });

  it('rejects when the caller does not own the order', async () => {
    service = build();

    await expect(service.verifyAndFulfillPurchase(dto, 'attacker')).rejects.toThrow(ForbiddenException);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects when the receipt is for a different product than the order', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, productId: 'in_gold_40000' });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects a pending purchase', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, purchaseState: 2 });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects an already-consumed purchase', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, consumptionState: 1 });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("rejects a token bound to another user's account", async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, externalAccountId: 'someone-else' });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(BadRequestException);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('still reports success when the consume call fails after a successful credit', async () => {
    service = build();
    consumeProductPurchase.mockRejectedValue(new Error('network'));

    const result = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(result.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/services/receipt-verification-guards.spec.ts`
Expected: FAIL — the constructor takes seven arguments, not eight, and none of the guards exist.

- [ ] **Step 3: Add the API client to the constructor**

In `src/modules/payments/services/receipt-verification.service.ts`, add the import and the eighth constructor parameter:

```ts
import { GooglePlayApiClient } from '../adapters/google-play-api.client';
```

```ts
    private readonly auditService: PurchaseAuditService,
    private readonly playApiClient: GooglePlayApiClient,
  ) {}
```

- [ ] **Step 4: Enforce order ownership**

In `verifyAndFulfillPurchase`, immediately after `const order = await this.orderService.getOrderById(dto.orderId);` and **before** the already-completed early return, insert:

```ts
    // The caller must own the order. Previously `actorId` was recorded for audit
    // but never compared, so any authenticated user could drive another user's
    // order through verification.
    if (actorId && order.userId !== actorId) {
      throw new ForbiddenException('Purchase order does not belong to the current user');
    }
```

Rename the parameter from `actorId?: string` to `actorId: string` in the signature — the controller always supplies it.

- [ ] **Step 5: Add the four purchase-integrity assertions**

Immediately after the existing `if (!verificationResult.isVerified) { ... }` block, insert:

```ts
    // A valid receipt is not automatically a receipt for THIS order. Each check
    // below is a distinct way a genuine purchase could settle an order it did not
    // pay for.
    const failIntegrity = async (reason: string): Promise<never> => {
      await this.orderService.updateOrderStatus(order.id, PurchaseOrderStatus.FAILED);
      await this.auditService.logAudit(order.id, 'PURCHASE_FAILED', { reason }, actorId);
      throw new BadRequestException(reason);
    };

    if (order.provider === PaymentProvider.GOOGLE_PLAY) {
      const expectedProductId = order.package?.googleProductId;

      if (!expectedProductId || verificationResult.productId !== expectedProductId) {
        await failIntegrity(
          `Receipt product '${verificationResult.productId}' does not match order package '${expectedProductId}'`,
        );
      }

      if (verificationResult.purchaseState !== 0) {
        await failIntegrity(
          `Purchase is not in the purchased state (purchaseState=${verificationResult.purchaseState})`,
        );
      }

      if (verificationResult.consumptionState !== 0) {
        await failIntegrity('Purchase has already been consumed and cannot be credited again');
      }

      if (verificationResult.externalAccountId !== order.userId) {
        await failIntegrity('Purchase is bound to a different account than the order');
      }
    }
```

Add `PaymentProvider` to the `@prisma/client` import at the top of the file.

- [ ] **Step 6: Consume after the credit**

Immediately after the `updateOrderStatus(..., COMPLETED, ...)` call and before the final `logAudit`, insert:

```ts
    // Consume LAST. If the credit had failed, the token stays unconsumed and Play
    // redelivers it, so the user's money is never taken without coins. A failure
    // here is logged but not fatal: the coins are already credited, and Play's own
    // consumption state prevents a second credit.
    if (order.provider === PaymentProvider.GOOGLE_PLAY && verificationResult.productId) {
      try {
        await this.playApiClient.consumeProductPurchase(
          verificationResult.productId,
          dto.receiptData,
        );
      } catch (err) {
        await this.auditService.logAudit(
          order.id,
          'CONSUME_FAILED',
          { reason: (err as Error).message },
          actorId,
        );
      }
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test -- src/modules/payments/services/receipt-verification-guards.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 8: Run the whole payments suite**

Run: `pnpm test -- src/modules/payments`
Expected: PASS. If `coin-purchase.spec.ts` fails because its mock order lacks `package.googleProductId` or its provider is `MOCK_GATEWAY`, note that the new assertions are scoped to `GOOGLE_PLAY` — fix by giving any `GOOGLE_PLAY` fixture a `package: { googleProductId: ... }` and matching result fields.

- [ ] **Step 9: Lint**

Run: `pnpm lint`
Expected: zero warnings.

- [ ] **Step 10: Checkpoint**

Stop and report which assertions now fire. Do not commit.

---

## Task 5: Scope order reads to their owner

**Repo:** backend

**Files:**
- Modify: `src/modules/payments/controllers/coin-purchase.controller.ts:99-106`
- Modify: `src/modules/payments/services/purchase-query.service.ts`
- Test: `src/modules/payments/services/purchase-query-ownership.spec.ts` (create)

**Interfaces:**
- Produces: `getOrderDetails(orderId: string, userId: string)` — the second parameter is required. The super-admin controller keeps its own unscoped read.

- [ ] **Step 1: Write the failing test**

Create `src/modules/payments/services/purchase-query-ownership.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { PurchaseQueryService } from './purchase-query.service';

/**
 * `GET /payments/orders/:id` took no caller identity, so any authenticated user
 * could read any order — amounts, package, provider reference and all. A foreign
 * order 404s rather than 403s so the endpoint does not confirm the ID exists.
 */
describe('PurchaseQueryService order ownership', () => {
  const ORDER = { id: 'order-1', userId: 'owner', orderNumber: 'ORD-1', coinsAmount: 250n, bonusCoinsAmount: 0n, totalCoins: 250n, priceAmount: 100 };

  const build = (found: any) => {
    const prisma: any = { purchaseOrder: { findFirst: jest.fn().mockResolvedValue(found) } };
    const orderService: any = { getOrderById: jest.fn() };
    return new PurchaseQueryService(prisma, orderService);
  };

  it('returns the order to its owner', async () => {
    const service = build(ORDER);

    const result = await service.getOrderDetails('order-1', 'owner');

    expect(result.id).toBe('order-1');
  });

  it('404s for a user who does not own the order', async () => {
    // The ownership filter is applied in the query, so a foreign order finds nothing.
    const service = build(null);

    await expect(service.getOrderDetails('order-1', 'someone-else')).rejects.toThrow(
      NotFoundException,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/services/purchase-query-ownership.spec.ts`
Expected: FAIL — `getOrderDetails` takes one argument and does not filter by user.

- [ ] **Step 3: Scope the query**

Read `src/modules/payments/services/purchase-query.service.ts` and replace its `getOrderDetails` with:

```ts
  /**
   * Order details for a specific user.
   *
   * `userId` is required: without it this endpoint returned any order to any
   * authenticated caller. A foreign order 404s rather than 403s, so the response
   * does not confirm that the ID exists.
   */
  async getOrderDetails(orderId: string, userId: string) {
    const order = await this.prisma.purchaseOrder.findFirst({
      where: {
        userId,
        OR: [{ id: orderId }, { orderNumber: orderId }],
      },
      include: { package: true, receipts: true },
    });

    if (!order) {
      throw new NotFoundException(`Purchase order '${orderId}' not found`);
    }

    return {
      ...order,
      coinsAmount: order.coinsAmount.toString(),
      bonusCoinsAmount: order.bonusCoinsAmount.toString(),
      totalCoins: order.totalCoins.toString(),
      priceAmount: Number(order.priceAmount),
    };
  }
```

Add `NotFoundException` to the `@nestjs/common` import.

- [ ] **Step 4: Pass the caller from the controller**

In `src/modules/payments/controllers/coin-purchase.controller.ts`, replace the `getOrderDetails` handler:

```ts
  @ApiOperation({ summary: 'Get purchase order details' })
  @ApiResponse({ status: 200, description: 'Purchase order details' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('orders/:id')
  async getOrderDetails(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.queryService.getOrderDetails(id, userId);
  }
```

- [ ] **Step 5: Fix the super-admin caller**

`src/modules/super-admin/controllers/super-admin-purchase.controller.ts` also calls `getOrderDetails`. Read it. If it calls the one-argument form, give the service a separate `getOrderDetailsForAdmin(orderId: string)` that keeps the unscoped `findFirst` (super admins legitimately read any order), and point the admin controller at it. Do not weaken the user-facing method to accommodate the admin one.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test -- src/modules/payments && pnpm test -- src/modules/super-admin`
Expected: PASS

- [ ] **Step 7: Lint**

Run: `pnpm lint`
Expected: zero warnings.

- [ ] **Step 8: Checkpoint**

Stop and report. Do not commit.

---

## Task 6: Wallet reversal path

**Repo:** backend

**Files:**
- Modify: `src/modules/wallet/services/wallet-transaction.service.ts`
- Test: `src/modules/wallet/services/wallet-reversal.spec.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  reverseWallet(dto: DebitWalletDto, actorId?: string): Promise<{
    transactionId: string; idempotencyKey: string; type: 'DEBIT';
    amount: string; balanceBefore: string; balanceAfter: string;
    availableBalance: string; status: TransactionStatus; createdAt: Date;
  }>
  ```
  Task 7 consumes this.

**Refinement on the spec:** `reverseWallet` skips **both** `validateSufficientBalance` and `validateWalletActive`. The spec named only the former, but a suspended wallet is precisely the fraud case a claw-back targets — blocking there would make the reversal permanently un-appliable, and the webhook would retry forever. `validateEconomyStatus` is kept: a freeze is short-lived and Pub/Sub's retry will apply the reversal once it lifts.

- [ ] **Step 1: Write the failing test**

Create `src/modules/wallet/services/wallet-reversal.spec.ts`:

```ts
import { WalletCurrency, WalletStatus, WalletTxnReason } from '@prisma/client';
import { WalletTransactionService } from './wallet-transaction.service';

/**
 * A refund claw-back has to work in exactly the cases a normal debit refuses:
 * the coins are already spent, or the wallet has since been suspended. Anything
 * that blocks here leaves refunded coins in circulation permanently.
 */
describe('WalletTransactionService.reverseWallet', () => {
  const WALLET = {
    id: 'wallet-1',
    userId: 'user-1',
    status: WalletStatus.ACTIVE,
    availableBalance: 10n,
    goldBalance: 10n,
    freeBalance: 0n,
    earningsBalance: 0n,
  };

  const build = (wallet: any = WALLET) => {
    const created: any[] = [];
    const tx: any = {
      $queryRaw: jest.fn(),
      wallet: {
        findUnique: jest.fn().mockResolvedValue(wallet),
        update: jest.fn().mockResolvedValue({ ...wallet, availableBalance: wallet.availableBalance - 250n }),
      },
      walletTransaction: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          created.push(data);
          return { id: 'tx-1', ...data, createdAt: new Date() };
        }),
      },
      ledgerEntry: { create: jest.fn() },
    };
    const prisma: any = {
      walletTransaction: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: (fn: any) => fn(tx),
    };
    const service = new WalletTransactionService(
      prisma,
      { getOrCreateWallet: jest.fn().mockResolvedValue(wallet) } as any,
      { appendLedgerEntry: jest.fn() } as any,
      {
        validateEconomyStatus: jest.fn().mockResolvedValue(undefined),
        validatePositiveAmount: jest.fn(),
        validateWalletActive: jest.fn(() => {
          throw new Error('validateWalletActive must not be called by reverseWallet');
        }),
        validateSufficientBalance: jest.fn(() => {
          throw new Error('validateSufficientBalance must not be called by reverseWallet');
        }),
      } as any,
      { logAudit: jest.fn() } as any,
    );
    return { service, tx };
  };

  const dto = {
    userId: 'user-1',
    amount: 250,
    currency: WalletCurrency.GOLD,
    reason: WalletTxnReason.PURCHASE_REVERSAL,
    idempotencyKey: 'REVERSAL_GPA.1',
  } as any;

  it('drives the balance negative when the coins are already spent', async () => {
    const { service } = build();

    const result = await service.reverseWallet(dto);

    expect(result.balanceAfter).toBe('-240');
    expect(result.type).toBe('DEBIT');
  });

  it('reverses against a suspended wallet', async () => {
    const { service } = build({ ...WALLET, status: WalletStatus.SUSPENDED });

    await expect(service.reverseWallet(dto)).resolves.toBeDefined();
  });

  it('is idempotent on a repeated key', async () => {
    const { service } = build();
    (service as any).prisma.walletTransaction.findUnique.mockResolvedValue({
      id: 'tx-existing',
      idempotencyKey: 'REVERSAL_GPA.1',
      amount: 250n,
      status: 'COMPLETED',
      createdAt: new Date(),
    });

    const result = await service.reverseWallet(dto);

    expect(result.transactionId).toBe('tx-existing');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/wallet/services/wallet-reversal.spec.ts`
Expected: FAIL — `service.reverseWallet is not a function`.

- [ ] **Step 3: Implement `reverseWallet`**

Add to `WalletTransactionService`, directly after `debitWallet`:

```ts
  /**
   * Debits a wallet for a reversal (refunded or charged-back purchase).
   *
   * Deliberately skips two checks that `debitWallet` enforces:
   *
   * - **Sufficient balance.** The coins are usually already spent by the time a
   *   refund lands; refusing would leave refunded coins in circulation. The
   *   balance goes negative and the user cannot spend again until they top up
   *   past zero, which every other debit path already enforces.
   * - **Wallet active.** A suspended wallet is precisely the fraud case a
   *   claw-back targets. Refusing here would make the reversal permanently
   *   un-appliable.
   *
   * Everything else is identical to `debitWallet`: economy-freeze validation,
   * row-level locking, idempotency, and the immutable ledger append.
   *
   * Private to the refund path by convention — no other caller may bypass the
   * overdraw guard.
   */
  async reverseWallet(dto: DebitWalletDto, actorId?: string) {
    await this.validationService.validateEconomyStatus();

    const amountBig = BigInt(dto.amount);
    this.validationService.validatePositiveAmount(amountBig);

    const existingTx = await this.prisma.walletTransaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });
    if (existingTx) {
      return this.formatTransactionResponse(existingTx);
    }

    const wallet = await this.walletService.getOrCreateWallet(dto.userId);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wallets WHERE id = ${wallet.id}::uuid FOR UPDATE`;
      const freshWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
      if (!freshWallet) throw new NotFoundException(`Wallet not found`);

      const balanceBefore = freshWallet.availableBalance;
      const balanceAfter = balanceBefore - amountBig;

      const transaction = await tx.walletTransaction.create({
        data: {
          transactionType: TransactionType.WITHDRAWAL,
          status: TransactionStatus.COMPLETED,
          sourceWalletId: wallet.id,
          currency: dto.currency ?? WalletCurrency.GOLD,
          amount: amountBig,
          idempotencyKey: dto.idempotencyKey,
          referenceType: dto.referenceType,
          referenceId: dto.referenceId,
          createdBy: actorId,
        },
      });

      const updatedWallet = await tx.wallet.update({
        where: { id: wallet.id },
        data: {
          availableBalance: { decrement: amountBig },
          totalSpent: { increment: amountBig },
          goldBalance: dto.currency === WalletCurrency.GOLD ? { decrement: amountBig } : undefined,
          freeBalance: dto.currency === WalletCurrency.FREE ? { decrement: amountBig } : undefined,
          earningsBalance:
            dto.currency === WalletCurrency.EARNINGS ? { decrement: amountBig } : undefined,
          version: { increment: 1 },
        },
      });

      await this.ledgerService.appendLedgerEntry(tx, {
        transactionId: transaction.id,
        walletId: wallet.id,
        type: WalletEntryType.DEBIT,
        currency: dto.currency ?? WalletCurrency.GOLD,
        reason: dto.reason ?? WalletTxnReason.PURCHASE_REVERSAL,
        amount: amountBig,
        balanceBefore,
        balanceAfter,
        referenceType: dto.referenceType,
        referenceId: dto.referenceId,
        description: dto.description ?? 'Purchase reversed',
        actorId,
      });

      await this.auditService.logAudit(
        wallet.id,
        'TRANSACTION_CREATED',
        { transactionId: transaction.id, type: 'REVERSAL', amount: amountBig.toString() },
        actorId,
      );

      return {
        transactionId: transaction.id,
        idempotencyKey: transaction.idempotencyKey,
        type: 'DEBIT' as const,
        amount: amountBig.toString(),
        balanceBefore: balanceBefore.toString(),
        balanceAfter: balanceAfter.toString(),
        availableBalance: updatedWallet.availableBalance.toString(),
        status: transaction.status,
        createdAt: transaction.createdAt,
      };
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- src/modules/wallet/services/wallet-reversal.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run the whole wallet suite**

Run: `pnpm test -- src/modules/wallet && pnpm lint`
Expected: PASS, zero lint warnings. The existing `wallet-ledger.spec.ts` and `wallet.service.spec.ts` must be untouched by this change.

- [ ] **Step 6: Checkpoint**

Stop and report. Do not commit.

---

## Task 7: RTDN refund webhook

**Repo:** backend

**Files:**
- Create: `src/modules/payments/dto/google-rtdn.dto.ts`
- Create: `src/modules/payments/services/google-rtdn.service.ts`
- Create: `src/modules/payments/controllers/google-rtdn.controller.ts`
- Modify: `src/modules/payments/payments.module.ts`
- Test: `src/modules/payments/services/google-rtdn.spec.ts` (create)

**Interfaces:**
- Consumes: `WalletTransactionService.reverseWallet` (Task 6), `PurchaseOrderService.updateOrderStatus` (existing).
- Produces: `POST /payments/webhooks/google-rtdn`, always 200 or 401 — never 4xx for an unrecognised but well-formed notification, because a non-2xx makes Pub/Sub redeliver.

- [ ] **Step 1: Write the failing test**

Create `src/modules/payments/services/google-rtdn.spec.ts`:

```ts
import { PurchaseOrderStatus } from '@prisma/client';
import { GoogleRtdnService } from './google-rtdn.service';

/**
 * Play refunds arrive here. The two properties that matter: a completed order is
 * reversed exactly once no matter how many times Pub/Sub redelivers, and an
 * unrecognised notification is swallowed rather than retried forever.
 */
describe('GoogleRtdnService', () => {
  const ORDER = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'user-1',
    status: PurchaseOrderStatus.COMPLETED,
    totalCoins: 250n,
    providerTxnRef: 'GPA.1',
  };

  const build = (order: any = ORDER) => {
    const reverseWallet = jest.fn().mockResolvedValue({ transactionId: 'tx-rev' });
    const updateOrderStatus = jest.fn().mockResolvedValue({ ...order, status: PurchaseOrderStatus.REFUNDED });
    const prisma: any = {
      purchaseOrder: { findFirst: jest.fn().mockResolvedValue(order) },
      paymentReceipt: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new GoogleRtdnService(
      prisma,
      { updateOrderStatus } as any,
      { reverseWallet } as any,
      { logAudit: jest.fn() } as any,
    );
    return { service, reverseWallet, updateOrderStatus, prisma };
  };

  const voided = {
    version: '1.0',
    packageName: 'com.soulzaa.app',
    eventTimeMillis: '1750000000000',
    voidedPurchaseNotification: { purchaseToken: 'tok-1', orderId: 'GPA.1', productType: 1, refundType: 1 },
  };

  it('reverses the coins for a completed order', async () => {
    const { service, reverseWallet, updateOrderStatus } = build();

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(true);
    expect(reverseWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        amount: 250,
        idempotencyKey: 'REVERSAL_GPA.1',
      }),
      undefined,
    );
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', PurchaseOrderStatus.REFUNDED);
  });

  it('does nothing for an order that was never completed', async () => {
    const { service, reverseWallet } = build({ ...ORDER, status: PurchaseOrderStatus.FAILED });

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown purchase token', async () => {
    const { service, reverseWallet, prisma } = build();
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('ignores notification types it does not handle', async () => {
    const { service, reverseWallet } = build();

    const result = await service.handleNotification({
      version: '1.0',
      packageName: 'com.soulzaa.app',
      eventTimeMillis: '1750000000000',
      testNotification: { version: '1.0' },
    } as any);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- src/modules/payments/services/google-rtdn.spec.ts`
Expected: FAIL — `Cannot find module './google-rtdn.service'`.

- [ ] **Step 3: Write the DTO**

Create `src/modules/payments/dto/google-rtdn.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

/** Play's DeveloperNotification, as published to the RTDN topic. */
export interface DeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  voidedPurchaseNotification?: {
    purchaseToken: string;
    orderId: string;
    /** 1 = one-time product, 2 = subscription. */
    productType?: number;
    /** 1 = full refund, 2 = partial refund. */
    refundType?: number;
  };
  oneTimeProductNotification?: Record<string, unknown>;
  subscriptionNotification?: Record<string, unknown>;
  testNotification?: Record<string, unknown>;
}

/** The Pub/Sub push envelope. `message.data` is base64 DeveloperNotification JSON. */
export class PubSubPushDto {
  @ApiProperty({ description: 'Pub/Sub message envelope' })
  @IsObject()
  message!: { data?: string; messageId?: string; publishTime?: string };

  @ApiProperty({ description: 'Subscription that delivered the message', required: false })
  @IsString()
  @IsOptional()
  subscription?: string;
}
```

- [ ] **Step 4: Write the service**

Create `src/modules/payments/services/google-rtdn.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { PurchaseOrderStatus, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';
import { DeveloperNotification } from '../dto/google-rtdn.dto';
import { PurchaseAuditService } from './purchase-audit.service';
import { PurchaseOrderService } from './purchase-order.service';

/**
 * Applies Play's real-time developer notifications.
 *
 * Only `voidedPurchaseNotification` is acted on. Everything else is recorded and
 * reported as unhandled, so the controller can still answer 200 — a non-2xx makes
 * Pub/Sub redeliver, and redelivering a notification nothing will ever act on is
 * a retry loop with no exit.
 */
@Injectable()
export class GoogleRtdnService {
  private readonly logger = new Logger(GoogleRtdnService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderService: PurchaseOrderService,
    private readonly walletTxService: WalletTransactionService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  async handleNotification(notification: DeveloperNotification): Promise<{ handled: boolean }> {
    const voided = notification.voidedPurchaseNotification;
    if (!voided) {
      this.logger.log(`Ignoring RTDN with no voidedPurchaseNotification`);
      return { handled: false };
    }

    const order = await this.findOrder(voided.orderId, voided.purchaseToken);
    if (!order) {
      this.logger.warn(`Voided purchase '${voided.orderId}' matches no purchase order`);
      return { handled: false };
    }

    if (order.status !== PurchaseOrderStatus.COMPLETED) {
      // Nothing was credited, so there is nothing to take back.
      await this.auditService.logAudit(order.id, 'REFUND_IGNORED', {
        reason: `Order status is ${order.status}`,
        orderId: voided.orderId,
      });
      return { handled: false };
    }

    // Idempotent on the Play order ID: a redelivered notification finds the
    // existing reversal transaction and returns it rather than debiting twice.
    await this.walletTxService.reverseWallet(
      {
        userId: order.userId,
        amount: Number(order.totalCoins),
        currency: WalletCurrency.GOLD,
        reason: WalletTxnReason.PURCHASE_REVERSAL,
        idempotencyKey: `REVERSAL_${voided.orderId}`,
        referenceType: 'purchase_order',
        referenceId: order.id,
        description: `Play refund: ${order.orderNumber}`,
      } as any,
      undefined,
    );

    await this.orderService.updateOrderStatus(order.id, PurchaseOrderStatus.REFUNDED);
    await this.auditService.logAudit(order.id, 'PURCHASE_REFUNDED', {
      orderId: voided.orderId,
      refundType: voided.refundType,
    });

    this.logger.log(`Reversed ${order.totalCoins} coins for refunded order ${order.orderNumber}`);
    return { handled: true };
  }

  /**
   * `providerTxnRef` holds the Play order ID recorded at verification. The receipt
   * fallback covers orders whose reference was never written — the purchase token
   * is stored as the receipt payload.
   */
  private async findOrder(playOrderId: string, purchaseToken: string) {
    const byRef = await this.prisma.purchaseOrder.findFirst({
      where: { providerTxnRef: playOrderId },
    });
    if (byRef) return byRef;

    const receipt = await this.prisma.paymentReceipt.findFirst({
      where: { receiptData: purchaseToken },
      include: { purchaseOrder: true },
    });
    return receipt?.purchaseOrder ?? null;
  }
}
```

- [ ] **Step 5: Write the controller**

Create `src/modules/payments/controllers/google-rtdn.controller.ts`:

```ts
import { Body, Controller, HttpCode, HttpStatus, Headers, Logger, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { OAuth2Client } from 'google-auth-library';
import { DeveloperNotification, PubSubPushDto } from '../dto/google-rtdn.dto';
import { GoogleRtdnService } from '../services/google-rtdn.service';

/**
 * Pub/Sub push target for Play's real-time developer notifications.
 *
 * Deliberately outside JwtAuthGuard — Google cannot present a Soulzaa JWT. It is
 * authenticated instead by verifying the OIDC token Pub/Sub attaches to the push,
 * so an anonymous POST cannot fabricate a refund and drive a wallet negative.
 */
@ApiTags('Coin Purchase & Payments')
@Controller('payments/webhooks')
export class GoogleRtdnController {
  private readonly logger = new Logger(GoogleRtdnController.name);
  private readonly oauthClient = new OAuth2Client();

  constructor(
    private readonly rtdnService: GoogleRtdnService,
    private readonly config: ConfigService,
  ) {}

  @ApiExcludeEndpoint()
  @Post('google-rtdn')
  @HttpCode(HttpStatus.OK)
  async handlePush(@Body() body: PubSubPushDto, @Headers('authorization') authorization?: string) {
    await this.assertGenuinePush(authorization);

    const encoded = body?.message?.data;
    if (!encoded) {
      // Well-formed but empty. 200 so Pub/Sub stops rather than retrying forever.
      this.logger.warn('RTDN push had no message data');
      return { received: true, handled: false };
    }

    let notification: DeveloperNotification;
    try {
      notification = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
    } catch {
      this.logger.warn('RTDN push data was not base64 JSON');
      return { received: true, handled: false };
    }

    const result = await this.rtdnService.handleNotification(notification);
    return { received: true, handled: result.handled };
  }

  private async assertGenuinePush(authorization?: string): Promise<void> {
    const audience = this.config.get('payments', { infer: true })?.googleRtdnPushAudience;
    if (!audience) {
      // Fail closed: an unconfigured webhook must not accept anonymous refunds.
      throw new UnauthorizedException('RTDN webhook is not configured');
    }

    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!token) {
      throw new UnauthorizedException('Missing Pub/Sub push token');
    }

    try {
      await this.oauthClient.verifyIdToken({ idToken: token, audience });
    } catch (err) {
      this.logger.warn(`Rejected RTDN push: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Pub/Sub push token');
    }
  }
}
```

- [ ] **Step 6: Register in the module**

In `src/modules/payments/payments.module.ts`: import `GoogleRtdnController` and `GoogleRtdnService`; add the controller to `controllers` and the service to `providers` and `exports`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test -- src/modules/payments/services/google-rtdn.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Run the payments suite and lint**

Run: `pnpm test -- src/modules/payments && pnpm lint`
Expected: PASS, zero warnings.

- [ ] **Step 9: Checkpoint**

Stop. Report the webhook path the user must configure as the Pub/Sub push endpoint: `https://api.soulzaa.com/payments/webhooks/google-rtdn`. Do not commit.

---

## Task 8: Mobile — product IDs and purchase API

**Repo:** mobile (`/Users/nasinaudaysankar/Downloads/soulzaa-mobile`)

**Files:**
- Modify: `pubspec.yaml`
- Modify: `lib/features/wallet/domain/entities/coin_package.dart`
- Modify: `lib/features/wallet/data/models/coin_package_model.dart`
- Create: `lib/features/wallet/domain/entities/purchase_order.dart`
- Create: `lib/features/wallet/data/models/purchase_order_model.dart`
- Create: `lib/features/wallet/data/datasources/coin_purchase_remote_data_source.dart`
- Test: `test/features/wallet/coin_purchase_data_test.dart` (create)

**Interfaces:**
- Consumes: `googleProductId` on `GET /payments/packages` (Task 1).
- Produces:
  ```dart
  class PurchaseOrder { final String id; final String orderNumber; final String status; final int totalCoins; }
  class CoinPurchaseRemoteDataSource {
    Future<PurchaseOrder> createOrder({required String packageId, required String idempotencyKey});
    Future<void> verify({required String orderId, required String purchaseToken});
  }
  ```
  Tasks 9 and 10 consume both.

- [ ] **Step 1: Write the failing test**

Create `test/features/wallet/coin_purchase_data_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/wallet/data/models/coin_package_model.dart';
import 'package:soulzaa_mobile/features/wallet/data/models/purchase_order_model.dart';
import 'package:soulzaa_mobile/features/wallet/domain/entities/coin_package.dart';
import 'package:soulzaa_mobile/features/wallet/domain/entities/purchase_order.dart';

void main() {
  group('CoinPackageModel', () {
    test('reads the Play product ID', () {
      final CoinPackage pkg = CoinPackageModel.fromJson(<String, dynamic>{
        'id': 'pkg-1',
        'code': 'IN_GOLD_100',
        'name': '250 Coins',
        'coins': '250',
        'bonusCoins': '0',
        'priceAmount': 100,
        'currency': 'INR',
        'sortOrder': 0,
        'googleProductId': 'in_gold_100',
      });

      expect(pkg.googleProductId, 'in_gold_100');
      expect(pkg.isPurchasableOnAndroid, isTrue);
    });

    test('a package with no product ID is not purchasable on Android', () {
      final CoinPackage pkg = CoinPackageModel.fromJson(<String, dynamic>{
        'id': 'pkg-2',
        'code': 'GLOBAL_1',
        'name': '100 Coins',
        'coins': '100',
        'bonusCoins': '0',
        'priceAmount': 1,
        'currency': 'USD',
        'sortOrder': 1,
      });

      expect(pkg.googleProductId, isNull);
      expect(pkg.isPurchasableOnAndroid, isFalse);
    });
  });

  group('PurchaseOrderModel', () {
    test('parses the order envelope, keeping BigInt coins as an int', () {
      final PurchaseOrder order = PurchaseOrderModel.fromJson(<String, dynamic>{
        'id': 'order-1',
        'orderNumber': 'ORD-1',
        'status': 'CREATED',
        'totalCoins': '250',
      });

      expect(order.id, 'order-1');
      expect(order.orderNumber, 'ORD-1');
      expect(order.status, 'CREATED');
      expect(order.totalCoins, 250);
    });
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/wallet/coin_purchase_data_test.dart`
Expected: FAIL — `purchase_order_model.dart` does not exist and `CoinPackage` has no `googleProductId`.

- [ ] **Step 3: Add the dependency**

In `pubspec.yaml`, under `dependencies:` after `dio`:

```yaml
  # Google Play Billing / StoreKit. Coins are virtual currency, which both stores
  # require be sold through their own billing — a gateway checkout inside the app
  # is a policy violation, not just a cheaper option.
  in_app_purchase: ^3.2.0
```

Run: `flutter pub get`

If the resolver reports a conflict, pin to the newest version compatible with the pinned Dart SDK (`>=3.10.0 <4.0.0`) and record the chosen version and the reason in the same comment block, matching how `firebase_performance` is pinned in this file.

- [ ] **Step 4: Extend the CoinPackage entity**

In `lib/features/wallet/domain/entities/coin_package.dart`, add the constructor parameter `this.googleProductId,` (optional, after `sortOrder`), and the field plus accessor:

```dart
  /// Google Play in-app product ID. Null for packages not configured for Android
  /// sale — the buy screen hides those rather than offering a button that fails
  /// inside the billing sheet.
  final String? googleProductId;

  bool get isPurchasableOnAndroid =>
      googleProductId != null && googleProductId!.isNotEmpty;
```

- [ ] **Step 5: Parse it in the model**

In `lib/features/wallet/data/models/coin_package_model.dart`, add to the `CoinPackage(...)` construction:

```dart
      googleProductId: json['googleProductId'] as String?,
```

- [ ] **Step 6: Add the PurchaseOrder entity and model**

Create `lib/features/wallet/domain/entities/purchase_order.dart`:

```dart
import 'package:flutter/foundation.dart';

/// An open coin purchase, as returned by `POST /payments/orders`.
///
/// Hand-written for the same reason as [CoinPackage]: codegen is unavailable in
/// this project. Only the fields the checkout flow actually uses are modelled.
@immutable
class PurchaseOrder {
  const PurchaseOrder({
    required this.id,
    required this.orderNumber,
    required this.status,
    required this.totalCoins,
  });

  final String id;

  /// Human-readable reference shown in purchase history and support tickets.
  final String orderNumber;

  /// Server-side lifecycle state (`CREATED`, `COMPLETED`, `FAILED`, ...).
  final String status;

  /// Coins this order will credit, base plus bonus.
  final int totalCoins;
}
```

Create `lib/features/wallet/data/models/purchase_order_model.dart`:

```dart
import 'package:soulzaa_mobile/features/wallet/domain/entities/purchase_order.dart';

/// JSON mapper for `POST /payments/orders`.
///
/// `totalCoins` is a Prisma `BigInt` and arrives as a **string**; parsed
/// defensively so a driver change degrades to zero rather than throwing in the
/// middle of a checkout.
class PurchaseOrderModel {
  const PurchaseOrderModel._();

  static PurchaseOrder fromJson(Map<String, dynamic> json) {
    return PurchaseOrder(
      id: json['id'] as String? ?? '',
      orderNumber: json['orderNumber'] as String? ?? '',
      status: json['status'] as String? ?? 'CREATED',
      totalCoins: _asInt(json['totalCoins']),
    );
  }

  static int _asInt(Object? value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? 0;
    return 0;
  }
}
```

- [ ] **Step 7: Add the purchase data source**

Create `lib/features/wallet/data/datasources/coin_purchase_remote_data_source.dart`:

```dart
import 'package:dio/dio.dart';
import 'package:soulzaa_mobile/core/constants/api_endpoints.dart';
import 'package:soulzaa_mobile/core/network/dio_client.dart';
import 'package:soulzaa_mobile/core/network/response_parser.dart';
import 'package:soulzaa_mobile/features/wallet/data/models/purchase_order_model.dart';
import 'package:soulzaa_mobile/features/wallet/domain/entities/purchase_order.dart';

/// Opens and settles coin purchase orders.
///
/// Neither method credits anything: [createOrder] only reserves an order the
/// backend will later match a store receipt against, and [verify] hands the
/// backend a Play purchase token to check with Google. The wallet is still only
/// ever credited server-side, after that check passes.
class CoinPurchaseRemoteDataSource {
  CoinPurchaseRemoteDataSource(this._dioClient);

  final DioClient _dioClient;

  Dio get _dio => _dioClient.dio;

  /// Opens an order for [packageId]. [idempotencyKey] must be stable for a given
  /// checkout attempt so a retried request returns the same order rather than
  /// opening a second one.
  Future<PurchaseOrder> createOrder({
    required String packageId,
    required String idempotencyKey,
  }) async {
    final Response<dynamic> response = await _dio.post<dynamic>(
      ApiEndpoints.paymentOrders,
      data: <String, dynamic>{
        'packageId': packageId,
        'provider': 'GOOGLE_PLAY',
        'idempotencyKey': idempotencyKey,
      },
    );
    return ResponseParser.parse<PurchaseOrder>(
      response,
      PurchaseOrderModel.fromJson,
    );
  }

  /// Hands the Play purchase token to the backend for verification and crediting.
  /// Safe to call more than once for the same purchase — the backend is
  /// idempotent on the store transaction.
  Future<void> verify({
    required String orderId,
    required String purchaseToken,
  }) async {
    await _dio.post<dynamic>(
      ApiEndpoints.paymentVerify,
      data: <String, dynamic>{
        'orderId': orderId,
        'receiptData': purchaseToken,
      },
    );
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `flutter test test/features/wallet/coin_purchase_data_test.dart`
Expected: PASS (3 tests)

- [ ] **Step 9: Analyze**

Run: `flutter analyze`
Expected: no issues.

- [ ] **Step 10: Checkpoint**

Stop and report the resolved `in_app_purchase` version. Do not commit.

---

## Task 9: Mobile — IAP platform wrapper and pending order store

**Repo:** mobile

**Files:**
- Create: `lib/features/wallet/data/datasources/iap_platform.dart`
- Create: `lib/features/wallet/data/datasources/pending_order_store.dart`
- Test: `test/features/wallet/pending_order_store_test.dart` (create)

**Interfaces:**
- Produces:
  ```dart
  abstract class IapPlatform {
    Stream<List<PurchaseDetails>> get purchaseStream;
    Future<bool> isAvailable();
    Future<List<ProductDetails>> queryProducts(Set<String> productIds);
    Future<void> buy({required ProductDetails product, required String applicationUserName});
    Future<void> complete(PurchaseDetails purchase);
    String? purchaseTokenOf(PurchaseDetails purchase);
  }

  class PendingOrderStore {
    Future<void> put(String productId, String orderId);
    Future<String?> take(String productId);
  }
  ```
  Task 10 consumes both.

- [ ] **Step 1: Write the failing test**

Create `test/features/wallet/pending_order_store_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/pending_order_store.dart';

/// A purchase can outlive the process that started it: Play delivers the result
/// after an app kill, and the order ID it must be verified against is only known
/// to the process that opened it. Losing that mapping means a paid-for purchase
/// nobody can settle.
void main() {
  test('returns the order ID for a product and clears it', () async {
    final Map<String, String> backing = <String, String>{};
    final PendingOrderStore store = PendingOrderStore.inMemory(backing);

    await store.put('in_gold_100', 'order-1');

    expect(await store.take('in_gold_100'), 'order-1');
    // Taken once: a second delivery of the same purchase must not re-settle an
    // order that is already done.
    expect(await store.take('in_gold_100'), isNull);
  });

  test('returns null for a product that was never started here', () async {
    final PendingOrderStore store = PendingOrderStore.inMemory(<String, String>{});

    expect(await store.take('in_gold_500'), isNull);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/wallet/pending_order_store_test.dart`
Expected: FAIL — `pending_order_store.dart` does not exist.

- [ ] **Step 3: Write the pending order store**

Read `lib/features/wallet/data/datasources/wallet_local_data_source.dart` first to match how `HiveService` is used in this feature (box naming, open/put/get calls). Then create `lib/features/wallet/data/datasources/pending_order_store.dart`:

```dart
import 'package:soulzaa_mobile/core/storage/hive_service.dart';

/// Remembers which purchase order a Play product was bought against.
///
/// The purchase result arrives on `purchaseStream`, which carries the product ID
/// but knows nothing about our order. Held on disk rather than in memory because
/// the common recovery case — app killed between paying and verifying — destroys
/// in-memory state, and Play redelivers the purchase on next launch.
///
/// One entry per product is enough: Play allows only one outstanding purchase of
/// a consumable at a time.
///
/// Not recoverable across a reinstall. A purchase stranded that way is left
/// unconsumed and Google auto-refunds it after three days, so the user is not out
/// of pocket.
class PendingOrderStore {
  PendingOrderStore(this._hive) : _memory = null;

  /// Test seam. Backed by a plain map so the store can be exercised without Hive.
  PendingOrderStore.inMemory(Map<String, String> backing)
    : _hive = null,
      _memory = backing;

  static const String _boxName = 'pending_coin_orders';

  final HiveService? _hive;
  final Map<String, String>? _memory;

  Future<void> put(String productId, String orderId) async {
    final Map<String, String>? memory = _memory;
    if (memory != null) {
      memory[productId] = orderId;
      return;
    }
    await _hive!.put(_boxName, productId, orderId);
  }

  /// Reads and removes the mapping. Removal is the point: a redelivered purchase
  /// must not settle an order that already completed.
  Future<String?> take(String productId) async {
    final Map<String, String>? memory = _memory;
    if (memory != null) {
      return memory.remove(productId);
    }
    final Object? value = await _hive!.get(_boxName, productId);
    if (value is! String) return null;
    await _hive!.delete(_boxName, productId);
    return value;
  }
}
```

Adjust the `_hive` calls to whatever `HiveService`'s real method names and signatures are — read the class before writing this, and keep the public surface of `PendingOrderStore` exactly as shown.

- [ ] **Step 4: Write the platform wrapper**

Create `lib/features/wallet/data/datasources/iap_platform.dart`:

```dart
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:in_app_purchase_android/in_app_purchase_android.dart';

/// The slice of the `in_app_purchase` plugin this app uses.
///
/// An interface rather than direct plugin calls so the checkout logic can be
/// tested without a platform channel — the purchase flow has more branches than
/// anything else in the wallet feature and is the last thing that should only be
/// verifiable by hand on a device.
abstract class IapPlatform {
  Stream<List<PurchaseDetails>> get purchaseStream;

  Future<bool> isAvailable();

  Future<List<ProductDetails>> queryProducts(Set<String> productIds);

  /// [applicationUserName] becomes Play's `obfuscatedAccountId`, which the
  /// backend compares against the order's user. Without it a purchase token from
  /// one account could be redeemed on another.
  Future<void> buy({
    required ProductDetails product,
    required String applicationUserName,
  });

  /// Clears the purchase from the local queue once it has been settled.
  Future<void> complete(PurchaseDetails purchase);

  /// The Play purchase token, or null on a non-Play purchase.
  String? purchaseTokenOf(PurchaseDetails purchase);
}

/// Real implementation, backed by the plugin.
class PluginIapPlatform implements IapPlatform {
  PluginIapPlatform(this._iap);

  final InAppPurchase _iap;

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => _iap.purchaseStream;

  @override
  Future<bool> isAvailable() => _iap.isAvailable();

  @override
  Future<List<ProductDetails>> queryProducts(Set<String> productIds) async {
    final ProductDetailsResponse response = await _iap.queryProductDetails(
      productIds,
    );
    return response.productDetails;
  }

  @override
  Future<void> buy({
    required ProductDetails product,
    required String applicationUserName,
  }) async {
    // autoConsume: false is load-bearing. The default consumes the purchase as
    // soon as it completes, before the backend has verified it — which would make
    // a failed credit unrecoverable. The backend consumes instead, after crediting.
    await _iap.buyConsumable(
      purchaseParam: PurchaseParam(
        productDetails: product,
        applicationUserName: applicationUserName,
      ),
      autoConsume: false,
    );
  }

  @override
  Future<void> complete(PurchaseDetails purchase) =>
      _iap.completePurchase(purchase);

  @override
  String? purchaseTokenOf(PurchaseDetails purchase) {
    if (purchase is GooglePlayPurchaseDetails) {
      // Read explicitly rather than via `serverVerificationData`, so what goes on
      // the wire is obvious at the call site.
      return purchase.billingClientPurchase.purchaseToken;
    }
    return null;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `flutter test test/features/wallet/pending_order_store_test.dart`
Expected: PASS (2 tests)

- [ ] **Step 6: Analyze**

Run: `flutter analyze`
Expected: no issues. If `in_app_purchase_android` is not directly importable, add it to `pubspec.yaml` alongside `in_app_purchase` — it is the platform package that defines `GooglePlayPurchaseDetails`.

- [ ] **Step 7: Checkpoint**

Stop and report. Do not commit.

---

## Task 10: Mobile — checkout controller and screen wiring

**Repo:** mobile

**Files:**
- Create: `lib/features/wallet/presentation/controllers/coin_purchase_controller.dart`
- Modify: `lib/features/wallet/presentation/screens/buy_coins_screen.dart:415-503`
- Modify: `lib/app.dart:68-72`
- Test: `test/features/wallet/coin_purchase_controller_test.dart` (create)

**Interfaces:**
- Consumes: `CoinPurchaseRemoteDataSource` (Task 8), `IapPlatform` and `PendingOrderStore` (Task 9), `coinPackagesControllerProvider` and `authControllerProvider` (existing).
- Produces: `coinPurchaseControllerProvider`, a `NotifierProvider<CoinPurchaseController, CoinPurchaseState>`.

- [ ] **Step 1: Write the failing test**

Create `test/features/wallet/coin_purchase_controller_test.dart`:

```dart
import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/iap_platform.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/pending_order_store.dart';
import 'package:soulzaa_mobile/features/wallet/presentation/controllers/coin_purchase_controller.dart';

class _FakeIapPlatform implements IapPlatform {
  final StreamController<List<PurchaseDetails>> controller =
      StreamController<List<PurchaseDetails>>.broadcast();
  final List<PurchaseDetails> completed = <PurchaseDetails>[];
  String? tokenToReturn = 'tok-1';

  @override
  Stream<List<PurchaseDetails>> get purchaseStream => controller.stream;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<List<ProductDetails>> queryProducts(Set<String> ids) async =>
      <ProductDetails>[];

  @override
  Future<void> buy({
    required ProductDetails product,
    required String applicationUserName,
  }) async {}

  @override
  Future<void> complete(PurchaseDetails purchase) async =>
      completed.add(purchase);

  @override
  String? purchaseTokenOf(PurchaseDetails purchase) => tokenToReturn;
}

class _FakePurchases {
  final List<List<String>> verified = <List<String>>[];
  bool shouldFail = false;

  Future<void> verify({
    required String orderId,
    required String purchaseToken,
  }) async {
    if (shouldFail) throw StateError('verify failed');
    verified.add(<String>[orderId, purchaseToken]);
  }
}

PurchaseDetails _purchased() => PurchaseDetails(
  productID: 'in_gold_100',
  purchaseID: 'pid-1',
  verificationData: PurchaseVerificationData(
    localVerificationData: '{}',
    serverVerificationData: 'tok-1',
    source: 'google_play',
  ),
  transactionDate: '0',
  status: PurchaseStatus.purchased,
);

/// The properties that protect the user's money: a purchase is verified before it
/// is completed, and a purchase whose verification fails is left in the queue so
/// Play redelivers it rather than being silently dropped.
void main() {
  late _FakeIapPlatform iap;
  late _FakePurchases purchases;
  late PendingOrderStore store;

  setUp(() {
    iap = _FakeIapPlatform();
    purchases = _FakePurchases();
    store = PendingOrderStore.inMemory(<String, String>{});
  });

  test('verifies a delivered purchase against its stored order, then completes it', () async {
    await store.put('in_gold_100', 'order-1');
    final CoinPurchaseHandler handler = CoinPurchaseHandler(
      iap: iap,
      store: store,
      verify: purchases.verify,
    );

    await handler.handlePurchase(_purchased());

    expect(purchases.verified.single, <String>['order-1', 'tok-1']);
    expect(iap.completed, hasLength(1));
  });

  test('does not complete a purchase whose verification failed', () async {
    await store.put('in_gold_100', 'order-1');
    purchases.shouldFail = true;
    final CoinPurchaseHandler handler = CoinPurchaseHandler(
      iap: iap,
      store: store,
      verify: purchases.verify,
    );

    await handler.handlePurchase(_purchased());

    // Left in the queue on purpose: Play redelivers it and the retry is free,
    // because /payments/verify is idempotent.
    expect(iap.completed, isEmpty);
  });

  test('does not verify a purchase with no known order', () async {
    final CoinPurchaseHandler handler = CoinPurchaseHandler(
      iap: iap,
      store: store,
      verify: purchases.verify,
    );

    await handler.handlePurchase(_purchased());

    expect(purchases.verified, isEmpty);
    expect(iap.completed, isEmpty);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `flutter test test/features/wallet/coin_purchase_controller_test.dart`
Expected: FAIL — `coin_purchase_controller.dart` does not exist.

- [ ] **Step 3: Write the controller**

Create `lib/features/wallet/presentation/controllers/coin_purchase_controller.dart`. It holds two pieces: a plain `CoinPurchaseHandler` that owns the settle logic (directly testable, no Riverpod), and the Riverpod `Notifier` that wires it to the app.

```dart
import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:in_app_purchase/in_app_purchase.dart';
import 'package:soulzaa_mobile/core/error/error_mapper.dart';
import 'package:soulzaa_mobile/core/error/failure.dart';
import 'package:soulzaa_mobile/core/providers/core_providers.dart';
import 'package:soulzaa_mobile/features/authentication/presentation/controllers/auth_controller.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/coin_purchase_remote_data_source.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/iap_platform.dart';
import 'package:soulzaa_mobile/features/wallet/data/datasources/pending_order_store.dart';
import 'package:soulzaa_mobile/features/wallet/domain/entities/coin_package.dart';
import 'package:soulzaa_mobile/features/wallet/domain/entities/purchase_order.dart';

typedef VerifyPurchase =
    Future<void> Function({required String orderId, required String purchaseToken});

/// Settles a delivered purchase: look up the order it belongs to, hand the token
/// to the backend, and only then clear it from the store queue.
///
/// Deliberately free of Riverpod so the ordering guarantees can be tested
/// directly — those guarantees are what stand between a paying user and a charge
/// with no coins.
class CoinPurchaseHandler {
  CoinPurchaseHandler({
    required IapPlatform iap,
    required PendingOrderStore store,
    required VerifyPurchase verify,
  }) : _iap = iap,
       _store = store,
       _verify = verify;

  final IapPlatform _iap;
  final PendingOrderStore _store;
  final VerifyPurchase _verify;

  /// Returns the failure if settling did not succeed, so the caller can surface it.
  Future<AppFailure?> handlePurchase(PurchaseDetails purchase) async {
    if (purchase.status != PurchaseStatus.purchased &&
        purchase.status != PurchaseStatus.restored) {
      return null;
    }

    final String? token = _iap.purchaseTokenOf(purchase);
    if (token == null) return null;

    final String? orderId = await _store.take(purchase.productID);
    if (orderId == null) {
      // No local record of which order this paid for. Left uncompleted on
      // purpose: Play auto-refunds an unconsumed purchase after three days, so
      // the user is not out of pocket, whereas completing it here would consume a
      // purchase that never credited.
      return const UnexpectedFailure(
        'This purchase could not be matched to an order. If coins do not arrive, '
        'they will be refunded automatically.',
      );
    }

    try {
      await _verify(orderId: orderId, purchaseToken: token);
    } catch (error, stackTrace) {
      // Put it back so a retry can find it, and leave the purchase in the queue
      // for Play to redeliver. /payments/verify is idempotent, so the retry costs
      // nothing.
      await _store.put(purchase.productID, orderId);
      return ErrorMapper.mapToFailure(error, stackTrace);
    }

    await _iap.complete(purchase);
    return null;
  }
}

/// Checkout state for the buy-coins screen.
class CoinPurchaseState {
  const CoinPurchaseState({
    this.inFlight = false,
    this.failure,
    this.lastCreditedCoins,
    this.products = const <String, ProductDetails>{},
  });

  /// True from the moment the order opens until the purchase settles or fails.
  /// The buy button is disabled while set, so a double tap cannot open two
  /// billing flows.
  final bool inFlight;
  final AppFailure? failure;
  final int? lastCreditedCoins;

  /// Play's own product details, keyed by product ID. `ProductDetails.price` is
  /// the localised amount Play will actually charge; the backend price is for
  /// reconciliation only.
  final Map<String, ProductDetails> products;

  CoinPurchaseState copyWith({
    bool? inFlight,
    AppFailure? failure,
    bool clearFailure = false,
    int? lastCreditedCoins,
    Map<String, ProductDetails>? products,
  }) => CoinPurchaseState(
    inFlight: inFlight ?? this.inFlight,
    failure: clearFailure ? null : (failure ?? this.failure),
    lastCreditedCoins: lastCreditedCoins ?? this.lastCreditedCoins,
    products: products ?? this.products,
  );
}

/// Drives the coin checkout and owns the purchase-stream subscription.
///
/// The subscription lives here, above any route, because Play delivers a purchase
/// whether or not the buy screen is still on top — including on the launch after
/// an app kill.
class CoinPurchaseController extends Notifier<CoinPurchaseState> {
  StreamSubscription<List<PurchaseDetails>>? _subscription;
  CoinPurchaseHandler? _handler;

  @override
  CoinPurchaseState build() {
    ref.onDispose(() => _subscription?.cancel());
    Future<void>(_listen);
    return const CoinPurchaseState();
  }

  Future<void> _listen() async {
    final IapPlatform iap = ref.read(iapPlatformProvider);
    if (!await iap.isAvailable()) return;

    _handler = CoinPurchaseHandler(
      iap: iap,
      store: ref.read(pendingOrderStoreProvider),
      verify: ref.read(coinPurchaseRemoteDataSourceProvider).verify,
    );

    _subscription = iap.purchaseStream.listen(_onPurchases);
  }

  Future<void> _onPurchases(List<PurchaseDetails> purchases) async {
    for (final PurchaseDetails purchase in purchases) {
      if (purchase.status == PurchaseStatus.pending) continue;

      if (purchase.status == PurchaseStatus.error ||
          purchase.status == PurchaseStatus.canceled) {
        await ref.read(iapPlatformProvider).complete(purchase);
        if (!ref.mounted) return;
        state = state.copyWith(
          inFlight: false,
          failure: purchase.status == PurchaseStatus.canceled
              ? null
              : const UnexpectedFailure('The payment did not go through.'),
          clearFailure: purchase.status == PurchaseStatus.canceled,
        );
        continue;
      }

      final AppFailure? failure = await _handler?.handlePurchase(purchase);
      if (!ref.mounted) return;
      state = state.copyWith(
        inFlight: false,
        failure: failure,
        clearFailure: failure == null,
      );
    }
  }

  /// Loads Play's product details for the catalogue so the screen can show the
  /// price Play will actually charge.
  Future<void> loadProducts(List<CoinPackage> packages) async {
    final Set<String> ids = packages
        .where((CoinPackage p) => p.isPurchasableOnAndroid)
        .map((CoinPackage p) => p.googleProductId!)
        .toSet();
    if (ids.isEmpty) return;

    final List<ProductDetails> details = await ref
        .read(iapPlatformProvider)
        .queryProducts(ids);
    if (!ref.mounted) return;
    state = state.copyWith(
      products: <String, ProductDetails>{
        for (final ProductDetails d in details) d.id: d,
      },
    );
  }

  /// Opens an order and launches the Play billing sheet.
  Future<void> buy(CoinPackage package) async {
    if (state.inFlight) return;

    final String? userId = ref.read(authControllerProvider).user?.id;
    final ProductDetails? product = state.products[package.googleProductId];
    if (userId == null || product == null) {
      state = state.copyWith(
        failure: const UnexpectedFailure('This bundle is not available right now.'),
      );
      return;
    }

    state = state.copyWith(inFlight: true, clearFailure: true);

    try {
      final PurchaseOrder order = await ref
          .read(coinPurchaseRemoteDataSourceProvider)
          .createOrder(
            packageId: package.id,
            // Stable per attempt: a retried request returns the same order
            // instead of opening a second one.
            idempotencyKey: 'ord_${userId}_${package.id}_'
                '${DateTime.now().millisecondsSinceEpoch}',
          );

      // Written before the billing sheet opens: if the app dies mid-payment, the
      // launch after it still knows which order the delivered purchase settles.
      await ref
          .read(pendingOrderStoreProvider)
          .put(package.googleProductId!, order.id);

      await ref
          .read(iapPlatformProvider)
          .buy(product: product, applicationUserName: userId);
    } catch (error, stackTrace) {
      if (!ref.mounted) return;
      state = state.copyWith(
        inFlight: false,
        failure: ErrorMapper.mapToFailure(error, stackTrace),
      );
    }
  }
}

final Provider<IapPlatform> iapPlatformProvider = Provider<IapPlatform>(
  (Ref ref) => PluginIapPlatform(InAppPurchase.instance),
);

final Provider<PendingOrderStore> pendingOrderStoreProvider =
    Provider<PendingOrderStore>(
      (Ref ref) => PendingOrderStore(ref.watch(hiveServiceProvider)),
    );

final Provider<CoinPurchaseRemoteDataSource> coinPurchaseRemoteDataSourceProvider =
    Provider<CoinPurchaseRemoteDataSource>(
      (Ref ref) => CoinPurchaseRemoteDataSource(ref.watch(dioClientProvider)),
    );

final NotifierProvider<CoinPurchaseController, CoinPurchaseState>
coinPurchaseControllerProvider =
    NotifierProvider<CoinPurchaseController, CoinPurchaseState>(
      CoinPurchaseController.new,
    );
```

Check `lib/core/error/failure.dart` for the concrete failure class name before using `UnexpectedFailure` — match whatever that file actually defines, and adjust every use above to it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `flutter test test/features/wallet/coin_purchase_controller_test.dart`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire the buy screen**

In `lib/features/wallet/presentation/screens/buy_coins_screen.dart`:

Replace `_AddCoinsButton._onPressed` (currently at lines 496-503) and make `_AddCoinsButton` a `ConsumerWidget` so it can read the controller:

```dart
  Future<void> _onPressed(BuildContext context, WidgetRef ref) async {
    final CoinPackage? pkg = package;
    if (pkg == null) return;
    await ref.read(coinPurchaseControllerProvider.notifier).buy(pkg);
  }
```

Gate the button on both the selection and the in-flight state — read `coinPurchaseControllerProvider` in `build` and set `enabled` to `package != null && !purchaseState.inFlight`. Swap the label for a `CircularProgressIndicator` while `inFlight`.

In `_Content.build`, hide packages Play cannot sell and prefer Play's price:

```dart
    // A package with no Play SKU cannot be bought on Android; showing it would be
    // a button that fails inside the billing sheet.
    final List<CoinPackage> purchasable = state.packages
        .where((CoinPackage p) => p.isPurchasableOnAndroid)
        .toList(growable: false);
```

Pass `purchasable` to `_PackageGrid` instead of `state.packages`. Where the grid and `_PaymentSummary` render a price, prefer `purchaseState.products[p.googleProductId]?.price` (Play's localised string) and fall back to the existing backend-derived formatting when Play has no details yet.

Add a `ref.listen` in `BuyCoinsScreen.build` that shows a `SnackBar` when `CoinPurchaseState.failure` becomes non-null, replacing the old "Checkout is not connected yet" message entirely.

Trigger the product load once the catalogue arrives — in `_Content.build`, add:

```dart
    ref.listen<CoinPackagesState>(coinPackagesControllerProvider, (
      CoinPackagesState? previous,
      CoinPackagesState next,
    ) {
      if (next.hasData) {
        unawaited(
          ref.read(coinPurchaseControllerProvider.notifier).loadProducts(next.packages),
        );
      }
    });
```

- [ ] **Step 6: Keep the subscription alive session-wide**

In `lib/app.dart`, inside `_AppChrome.build`, alongside the other always-on watches:

```dart
    // Play delivers a purchase whether or not the buy screen is still on top —
    // including on the launch after an app kill interrupted a payment. The
    // subscription has to outlive the screen that started it.
    ref.watch(coinPurchaseControllerProvider);
```

Add the import for `coin_purchase_controller.dart`.

- [ ] **Step 7: Run the wallet tests**

Run: `flutter test test/features/wallet`
Expected: PASS, including the existing `buy_coins_overflow_test.dart` and `wallet_test.dart`. If the overflow test fails because the button now renders a spinner or the grid filters packages, update its fixture to supply `googleProductId` rather than loosening the widget.

- [ ] **Step 8: Analyze**

Run: `flutter analyze`
Expected: no issues.

- [ ] **Step 9: Checkpoint**

Stop and report. Note that end-to-end verification needs the Play Console prerequisites from the spec — nothing before that point can confirm a real purchase. Do not commit.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Schema: `googleProductId` / `appleProductId` | 1 |
| Schema: `PURCHASE_REVERSAL` | 1 |
| Play Developer API adapter, licence-key path removed | 2, 3 |
| Five verification assertions | 4 |
| Consume after credit | 4 |
| `GET /payments/orders/:id` ownership | 5 |
| `/payments/verify` caller check | 4 |
| RTDN webhook with Pub/Sub token verification | 7 |
| `reverseWallet` allowing negative | 6 |
| Config: three new env vars | 2 |
| Mobile: `in_app_purchase`, `autoConsume: false` | 8, 9 |
| Mobile: `applicationUserName` → `obfuscatedAccountId` | 9 |
| Mobile: token read from `billingClientPurchase.purchaseToken` | 9 |
| Mobile: `createOrder` / `verify` on the data source | 8 |
| Mobile: store prices win over backend prices | 10 |
| Mobile: launch-time recovery | 10 |
| Testing: adapter, verification, RTDN, reversal, IapService | 2, 3, 4, 6, 7, 9, 10 |

No spec requirement is unassigned. iOS, subscriptions, promotional campaigns and an admin product-ID screen are explicitly out of scope in the spec and have no tasks, as intended.

**Known limitation, carried from the design:** a purchase interrupted by an app *reinstall* (not merely a kill) loses its `productId → orderId` mapping and cannot be settled. Google auto-refunds the unconsumed purchase after three days, so the user is made whole. Task 10 surfaces this to the user rather than failing silently. Closing it properly would need a backend order-resolution endpoint; that is a follow-up, not part of this plan.

**Type consistency checked:** `googleProductId` is spelled identically in Prisma, the DTOs, the service response, the Dart entity, the Dart model and the tests. `reverseWallet(dto, actorId?)` matches its call in Task 7. `getOrderDetails(orderId, userId)` matches its controller call in Task 5. `GooglePlayApiClient.{isConfigured,getProductPurchase,consumeProductPurchase}` match their uses in Tasks 3 and 4. `IapPlatform`'s six members match both the fake in the Task 10 test and `PluginIapPlatform` in Task 9. `PendingOrderStore.{put,take}` match across Tasks 9 and 10.
