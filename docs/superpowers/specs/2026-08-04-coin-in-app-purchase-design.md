# Coin In-App Purchase — Google Play Billing

**Date:** 2026-08-04
**Repos:** `soulzaa-backend`, `soulzaa-mobile`
**Status:** Approved for implementation

## Problem

The coin catalogue is visible in the mobile app but cannot be bought. `buy_coins_screen.dart`
lists the nine INR tiers and its "Add coins" button shows *"Checkout is not connected yet"*,
because the payment route was an unresolved product decision.

The backend already has most of a purchase system — `CoinPackage`, `PurchaseOrder`,
`PaymentReceipt` and `PurchaseAudit` models, a `/payments` controller, provider adapters, and
wallet crediting through the double-entry ledger. What is missing is a store-billing path that
is safe to take real money through, and a client that uses it.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Billing route | Google Play Billing only | Play and App Store policy require store billing for virtual currency. A Razorpay in-app coin purchase risks app removal. |
| Platforms | Android first; iOS is a later spec | Matches where builds and testing already are. The Apple adapter uses Apple's deprecated `/verifyReceipt` and needs replacing before iOS ships. |
| Verification | Play Developer API `purchases.products.get` | Reports purchase state, consumption state, and account binding. Offline signature verification proves authenticity but cannot detect a refunded, pending, or already-consumed purchase. |
| Refunds | Play RTDN webhook, auto claw-back, balance may go negative | Catches purchase-and-refund abuse without a human in the loop. A negative balance blocks further spending until settled. |

Razorpay and Stripe adapters stay in the codebase for non-coin use. They are off the coin path.

## Purchase flow

```
1. App    → GET  /payments/packages       → tiers, each with its Play product ID
2. App    → POST /payments/orders         → PurchaseOrder (CREATED), returns orderId
3. App    → Play Billing launchBillingFlow(productId, obfuscatedAccountId = userId)
4. Play   → purchaseStream: PurchaseDetails { purchaseToken, productId }
5. App    → POST /payments/verify { orderId, receiptData: purchaseToken }
6. Server → Play Developer API purchases.products.get(packageName, productId, token)
7. Server → credit wallet (existing ledger, idempotent)
8. Server → purchases.products.consume, order → COMPLETED
9. App    → completePurchase() to clear the local queue
```

Two orderings are load-bearing:

- **Credit before consume.** If the credit fails, the token stays unconsumed and Play redelivers
  it, so the user's money is never taken without coins. If consume ran first, a failed credit
  would be unrecoverable.
- **Server-side consume.** The three-day acknowledgement deadline is met by the backend rather
  than by a client that may be killed mid-flow.

If the app dies between steps 4 and 5, `purchaseStream` redelivers the purchase on next launch
and the app re-posts to `/payments/verify`, which is idempotent.

Order status moves `CREATED → PENDING_PAYMENT → VERIFICATION_PENDING → COMPLETED`. Today orders
jump straight from `CREATED` to `COMPLETED`, leaving the intermediate states unused.

## Backend changes

### Schema

`CoinPackage` gains the store mapping it lacks today:

```prisma
googleProductId String? @unique
appleProductId  String? @unique
```

Play product IDs must start with a lowercase letter or digit and contain only lowercase letters,
digits, `_` and `.`. The existing `IN_GOLD_100`-style codes cannot be used directly. The
migration backfills `googleProductId = lower(code)`, giving `in_gold_100` through
`in_gold_40000`. `appleProductId` stays null until the iOS spec.

`WalletTxnReason` gains `PURCHASE_REVERSAL` for refund claw-backs. It is distinct from
`ADMIN_DEBIT` so reversals are separable in financial reporting.

### Google Play adapter

`GooglePlayAdapter` is rewritten to call
`GET /androidpublisher/v3/applications/{packageName}/purchases/products/{productId}/tokens/{token}`,
authenticated with a service-account JWT. `google-auth-library@^10.9.0` is already a dependency
and provides the JWT client, so no new package is required.

The offline RSA-SHA1 signature path is **removed**, not retained as a fallback. A fallback that
approves purchases the API would reject is a hole, not a safety net. The adapter keeps failing
closed when unconfigured, matching the behaviour asserted in `fail-closed.spec.ts`.

`VerificationResult` gains `productId`, `purchaseState`, `consumptionState` and
`obfuscatedExternalAccountId` so the verification service can assert on them. The added fields
are optional, so the other adapters compile unchanged.

`receiptData` carries the Play purchase token. The `signature` field goes unused for this
provider.

### Verification service

`ReceiptVerificationService.verifyAndFulfillPurchase` adds five assertions before crediting.
Each fails closed and marks the order `FAILED`:

| Assertion | Guards against |
|---|---|
| `order.userId === callerId` | verifying another user's order |
| `result.productId === package.googleProductId` | buying the ₹100 SKU against a ₹40,000 order |
| `purchaseState === 0` | crediting a pending or cancelled purchase |
| `consumptionState === 0` | re-crediting an already-used token |
| `obfuscatedExternalAccountId === order.userId` | redeeming another account's token |

The product-ID check is the important one: verification currently never compares the receipt's
product to the order's package, so any valid receipt can settle any order.

After a successful wallet credit, the service calls `purchases.products.consume`. A consume
failure is logged and audited but does not fail the request — the coins are already credited and
Play's own consumption state prevents a double credit.

### Existing holes fixed in the same pass

Both are in `coin-purchase.controller.ts`:

- `GET /payments/orders/:id` takes no `@CurrentUser` and applies no ownership filter. Any
  authenticated user can read any order. Fix: pass the caller and 404 on a foreign order.
- `POST /payments/verify` passes `userId` only as an audit actor and never compares it to
  `order.userId`. Covered by the first assertion above.

### RTDN webhook

New `POST /payments/webhooks/google-rtdn`. It is outside `JwtAuthGuard` and authenticated
instead by verifying the Pub/Sub push OIDC token against `GOOGLE_RTDN_PUSH_AUDIENCE` using
`google-auth-library`'s `OAuth2Client.verifyIdToken`. An unverified token is rejected with 401
and nothing is processed.

Only `voidedPurchaseNotification` is handled in this spec. Other notification types are
acknowledged with 200 and audited, so Pub/Sub does not retry them forever.

On a voided purchase:

1. Find the `PurchaseOrder` by `providerTxnRef` (the order ID) or by the receipt's purchase token.
2. If not found or not `COMPLETED`, audit and return 200 — nothing to reverse.
3. Reverse `totalCoins` from the user's wallet with reason `PURCHASE_REVERSAL`, idempotency key
   `REVERSAL_<providerTxnId>`.
4. Set order status `REFUNDED`.

Returning 200 for unactionable notifications is deliberate: a non-2xx makes Pub/Sub redeliver.

### Wallet reversal path

`WalletTransactionService.debitWallet` calls `validateSufficientBalance` and throws when the user
has already spent the coins — exactly the case a claw-back exists for. A new `reverseWallet()`
method skips only that check and keeps everything else identical: row-level `FOR UPDATE` locking,
immutable ledger append, idempotency key handling, and economy-status validation.

It is used only by the refund path. Every other caller keeps the overdraw protection.

A negative `availableBalance` means the user cannot spend until they top up past zero, which the
existing sufficient-balance check already enforces for gifts, games and cosmetics.

### Configuration

New environment variables in `env.validation.ts` and `paymentsConfig`:

| Variable | Purpose |
|---|---|
| `GOOGLE_PLAY_PACKAGE_NAME` | Android applicationId, e.g. `com.soulzaa.app` |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Service-account credentials for the Android Publisher API |
| `GOOGLE_RTDN_PUSH_AUDIENCE` | Expected audience when verifying Pub/Sub push tokens |

`GOOGLE_PLAY_LICENSE_KEY` is retired. All three are optional in the schema so non-production
environments boot without them; the adapter fails closed when they are absent.

## Mobile changes

### Dependency

`in_app_purchase` added to `pubspec.yaml`. The plugin merges the
`com.android.vending.BILLING` permission, so `AndroidManifest.xml` needs no manual edit — this
gets verified against the merged manifest rather than assumed.

No code generation is involved. `build_runner` cannot run in this project (dart_style is too old
for the pinned Dart SDK), so all new models are hand-written, matching the existing
`CoinPackage` entity.

### IapService

New `lib/features/wallet/data/datasources/iap_service.dart` owning the plugin lifecycle:

- `queryProductDetails` for the `googleProductId`s the backend returned. A package whose SKU is
  missing from Play is hidden rather than shown as a button that fails.
- `buyConsumable(purchaseParam: ..., autoConsume: false)`. **`autoConsume: false` is essential** —
  the default `true` consumes the purchase before the server ever sees the token, which would
  leave a failed credit unrecoverable.
- `PurchaseParam(applicationUserName: userId)`, which populates `obfuscatedAccountId` for the
  server-side account check.
- A `purchaseStream` subscription that posts to `/payments/verify`, then calls
  `completePurchase()`.

The purchase token is read from `GooglePlayPurchaseDetails.billingClientPurchase.purchaseToken`
rather than from `serverVerificationData`, so what goes on the wire is explicit at the call site.

### Data layer

`CoinPackageRemoteDataSource` gains `createOrder()` and `verify()`. Its "read-only by design"
comment is rewritten: the invariant it protected — only the backend credits coins — still holds,
because neither new method credits anything. `ApiEndpoints.paymentOrders` and
`ApiEndpoints.paymentVerify` already exist.

`CoinPackage` entity and model gain `googleProductId`.

### Presentation

`buy_coins_screen.dart`'s `_onPressed` runs the real flow with in-flight, success and error
states. The button is disabled while a purchase is in flight so a double tap cannot open two
billing flows.

**Prices displayed come from `ProductDetails.price`, not from the backend `priceAmount`.** The
store's localised price is what Play actually charges. Backend `priceAmount` stays for
reconciliation and admin reporting. A mismatch between the two is logged, and Play wins.

### Recovery

The `purchaseStream` subscription starts at app launch, not when the buy screen opens, so a
purchase interrupted by an app kill is verified and credited the next time the app runs.

## Testing

Backend, following the existing spec files in `src/modules/payments`:

- Adapter: rejects when unconfigured; maps `purchaseState` and `consumptionState`; surfaces
  `productId` and `obfuscatedExternalAccountId`; treats an API error as unverified.
- Verification service: one test per assertion in the table above, each asserting no wallet
  credit occurred. Plus the existing idempotent-replay and already-completed cases.
- RTDN: rejects an unverified push token; reverses a completed order; is idempotent on
  redelivery; returns 200 for an unknown token.
- Reversal: drives a wallet negative when coins are already spent; is idempotent on the same key.

Mobile:

- `IapService` with a faked `InAppPurchase` platform: verify path posts before consuming; a
  failed verify does not consume; a redelivered purchase is re-verified.

Manual, on a real device with a licence-tester account: buy the smallest tier, confirm coins
land, confirm the order shows `COMPLETED`, then refund it in Play Console and confirm the
claw-back.

## Out of scope

- iOS / StoreKit. The Apple adapter stays as-is and unused; replacing `/verifyReceipt` with the
  App Store Server API belongs to the iOS spec.
- Subscriptions. Coins are consumables only.
- Promotional or bonus-coin campaigns. `bonusCoins` is already supported and is currently zero
  for every tier.
- Admin UI for editing `googleProductId`. The super-admin package endpoints accept it through the
  existing DTOs; a dedicated screen is not part of this work.

## Prerequisites from the Play Console

Implementation can proceed without these, but nothing can be tested end-to-end until they exist:

| Item | Where |
|---|---|
| App uploaded to a Play track (internal testing suffices) | Play Console — IAP cannot be tested before a build exists |
| Nine in-app products, IDs `in_gold_100` … `in_gold_40000` | Monetise → In-app products |
| Prices matching the ₹ tiers | Same screen. Confirm ₹40,000 is within Play's per-item price cap for India; if not, that tier is repriced or dropped. |
| Service account with Android Publisher access | Google Cloud IAM, then linked under Play Console → API access |
| Pub/Sub topic and push subscription to `/payments/webhooks/google-rtdn` | Google Cloud Console, then set under Monetisation setup |
| Licence testers | Setup → Licence testing, so purchases are not charged |
| Confirmed production `applicationId` | Needed for `GOOGLE_PLAY_PACKAGE_NAME` |
