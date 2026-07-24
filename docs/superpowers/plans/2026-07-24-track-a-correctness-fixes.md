# Track A — Correctness Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix eight confirmed correctness/security/economic defects from the 2026-07-24 audit, each proven by a TDD regression test, with zero new features and zero contract changes.

**Architecture:** Surgical edits to existing NestJS services/guards/config. No schema changes. Wallet-touching defects (currency validation, VIP atomicity, gift double-pay) are done first and covered by exact-balance regression tests.

**Tech Stack:** NestJS 11, Prisma/PostgreSQL, Jest + `@nestjs/testing`, BullMQ, Redis, Socket.IO. Package manager `pnpm`.

## Global Constraints

- **TDD-first:** every task writes a failing regression test that reproduces the bug BEFORE the fix. Copy these verbatim into steps.
- **Preserve contracts:** no change to REST request/response **schemas**, endpoint paths, or Socket.IO **event names/payload shapes**. Human-readable exception *messages* may change; corrected numeric *values* that directly result from a fix are allowed and called out.
- **No scope creep:** touch only the code the defect requires. No opportunistic refactors. Do NOT delete `GiftTransactionService` (only its HTTP route).
- **Wallet fully covered:** defects handled in Tasks 1–3 must assert exact `goldBalance`/`freeBalance`/`earningsBalance`/`availableBalance` and ledger-row counts.
- **NO GIT / NO MIGRATIONS:** working-tree-only project. Do NOT run `git commit`, `git reset`, or `prisma migrate`. Each task ends with a **verification checkpoint** (tests + lint + boundaries), not a commit. None of these fixes need a schema change.
- **Commands:** unit tests `pnpm test`; single file `pnpm test -- <path>`; lint `pnpm lint`; boundaries `pnpm boundaries`. All must stay green.

---

## File Structure (what each task touches)

- **Task 1 (Defect 3):** `src/modules/wallet/services/wallet-validation.service.ts` (currency-aware balance check), `src/modules/wallet/services/wallet-transaction.service.ts` (pass currency at both callsites), test `…/wallet-validation.service.spec.ts`.
- **Task 2 (Defect 4):** `src/modules/vip/services/vip-subscription.service.ts` (atomic debit + deterministic keys), test `…/vip-subscription.service.spec.ts`.
- **Task 3 (Defect 2):** `src/modules/video-rooms/services/video-room-gift-context.handler.ts` (economics → 0), `src/modules/revenue/services/revenue-event.service.ts` (gate to host contexts), `src/modules/gifts/events/gift.events.ts` (ensure `contextType` on payload), tests in revenue + gifts.
- **Task 4 (Defect 1):** `src/modules/gifts/controllers/gifts.controller.ts` (remove `POST send`), test `…/gifts.controller.spec.ts`.
- **Task 5 (Defect 5):** 10 controllers migrated to `RbacPermissionsGuard`; delete `src/common/guards/permission.guard.ts`; per-controller tests.
- **Task 6 (Defect 6):** `src/infra/queue/dlq.service.ts` (real re-enqueue), `src/infra/queue/queue.service.ts` (`getQueue` accessor), test `…/dlq.service.spec.ts`.
- **Task 7 (Defect 7):** `src/infra/ops/disaster-recovery.service.ts:37` (env var name), test.
- **Task 8 (Defect 8):** `k8s/04-ingress-netpol.yaml` (UDP/53 egress), manifest validation.

---

## Task 1: Currency-scoped balance validation (Defect 3)

**Files:**
- Modify: `src/modules/wallet/services/wallet-validation.service.ts:46-52`
- Modify: `src/modules/wallet/services/wallet-transaction.service.ts:141,149`
- Test: `src/modules/wallet/services/wallet-validation.service.spec.ts`

**Interfaces:**
- Produces: `validateSufficientBalance(wallet: Wallet, requiredAmount: bigint, currency?: WalletCurrency): void` — now checks the sub-balance matching `currency` (default `GOLD`).

- [ ] **Step 1: Write the failing test.** Follow the module-setup pattern of neighboring wallet specs. If `wallet-validation.service.spec.ts` does not exist, create it (the service has only `CoinEconomyService` + `FeatureFlagService` deps, both irrelevant to this pure method — inject `{} as any`).

```ts
import { BadRequestException } from '@nestjs/common';
import { WalletCurrency, WalletStatus, Wallet } from '@prisma/client';
import { WalletValidationService } from './wallet-validation.service';

const wallet = (over: Partial<Wallet>): Wallet =>
  ({
    id: 'w1', status: WalletStatus.ACTIVE,
    goldBalance: 0n, freeBalance: 0n, earningsBalance: 0n,
    availableBalance: 0n, reservedBalance: 0n, pendingBalance: 0n, lockedBalance: 0n,
    ...over,
  }) as Wallet;

describe('WalletValidationService.validateSufficientBalance (currency-scoped)', () => {
  const svc = new WalletValidationService({} as any, {} as any);

  it('rejects a GOLD debit when only FREE coins are available', () => {
    // availableBalance is the aggregate; goldBalance is 0 → GOLD debit must fail.
    const w = wallet({ goldBalance: 0n, freeBalance: 100n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n, WalletCurrency.GOLD)).toThrow(
      BadRequestException,
    );
  });

  it('allows a GOLD debit when goldBalance is sufficient', () => {
    const w = wallet({ goldBalance: 100n, freeBalance: 0n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n, WalletCurrency.GOLD)).not.toThrow();
  });

  it('validates FREE and EARNINGS against their own sub-balances', () => {
    const w = wallet({ freeBalance: 10n, earningsBalance: 5n, availableBalance: 15n });
    expect(() => svc.validateSufficientBalance(w, 8n, WalletCurrency.FREE)).not.toThrow();
    expect(() => svc.validateSufficientBalance(w, 8n, WalletCurrency.EARNINGS)).toThrow();
  });

  it('defaults to GOLD when no currency is supplied', () => {
    const w = wallet({ goldBalance: 0n, freeBalance: 100n, availableBalance: 100n });
    expect(() => svc.validateSufficientBalance(w, 50n)).toThrow(BadRequestException);
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `pnpm test -- wallet-validation.service.spec.ts` → FAIL (first test passes today wrongly, or arity error). Expected: the GOLD-vs-FREE cases fail against current aggregate logic.

- [ ] **Step 3: Implement the currency-aware check.** In `wallet-validation.service.ts`, add `WalletCurrency` to the `@prisma/client` import and replace `validateSufficientBalance`:

```ts
import { Wallet, WalletCurrency, WalletStatus } from '@prisma/client';

// …

  /**
   * Validates sufficient balance in the sub-balance matching the debit currency.
   * availableBalance is an aggregate of gold+free+earnings, so validating it
   * would let one currency's coins satisfy another's debit (and drive a
   * sub-balance negative). PRD: FREE coins cannot buy gifts/VIP/treasure.
   */
  validateSufficientBalance(
    wallet: Wallet,
    requiredAmount: bigint,
    currency: WalletCurrency = WalletCurrency.GOLD,
  ) {
    const balance =
      currency === WalletCurrency.FREE
        ? wallet.freeBalance
        : currency === WalletCurrency.EARNINGS
          ? wallet.earningsBalance
          : wallet.goldBalance;
    if (balance < requiredAmount) {
      throw new BadRequestException(
        `Insufficient ${currency} balance. Required: ${requiredAmount.toString()}, Available: ${balance.toString()}`,
      );
    }
  }
```

- [ ] **Step 4: Thread currency at debit callsites.** In `wallet-transaction.service.ts`, update BOTH calls (pre-tx `:141` and in-tx `:149`) to pass the currency:

```ts
// line ~141 (pre-transaction)
this.validationService.validateSufficientBalance(wallet, amountBig, dto.currency ?? WalletCurrency.GOLD);
// line ~149 (inside $transaction, on freshWallet)
this.validationService.validateSufficientBalance(freshWallet, amountBig, dto.currency ?? WalletCurrency.GOLD);
```

- [ ] **Step 5: Find and fix any other callers.** Run `grep -rn "validateSufficientBalance" src/` — update any additional callsite to pass the correct currency (transfer path, if present). Leave the default `GOLD` where the caller has no explicit currency.

- [ ] **Step 6: Run tests + regression.** `pnpm test -- wallet` → PASS. Confirm existing wallet debit/gift/VIP specs still green.

- [ ] **Step 7: Verification checkpoint.** `pnpm lint` and `pnpm boundaries` green. (No commit — working-tree-only.)

---

## Task 2: VIP purchase atomic + idempotent (Defect 4)

**Files:**
- Modify: `src/modules/vip/services/vip-subscription.service.ts` (all four methods)
- Test: `src/modules/vip/services/vip-subscription.service.spec.ts`

**Interfaces:**
- Consumes: `IWalletService.debit(input, tx?: Prisma.TransactionClient)` (accepts an outer transaction — verified in `wallet.service.ts:80`).
- Produces: unchanged public method signatures (`purchaseVip`, `renewVip`, `upgradeVip`, `giftVip`).

**Fix summary:** (a) move each `walletService.debit(...)` INSIDE the method's `this.prisma.$transaction(async (tx) => …)`, passing `tx` as the 2nd arg, so debit + membership writes are atomic; (b) replace every `Date.now()` idempotency key with a key bound to the state the operation transitions FROM (stable across retries, unique per logical operation).

Deterministic keys:
- purchase: `vip:purchase:${userId}:${level}:${existing?.expiresAt?.toISOString() ?? 'new'}`
- renew: `vip:renew:${userId}:${membership.level}:${membership.expiresAt.toISOString()}`
- upgrade: `vip:upgrade:${userId}:${membership.level}->${targetLevel}`
- gift: `vip:gift:${gifterUserId}:${recipientUserId}:${level}:${existingRecipient?.expiresAt?.toISOString() ?? 'new'}` (add a `findUnique` for the recipient's current membership to build the key)

- [ ] **Step 1: Write the failing tests.** Follow the neighboring VIP spec harness for module setup and mocks. Two guarantees per path; minimum viable set:

```ts
describe('VipSubscriptionService — atomicity & idempotency', () => {
  it('rolls back the coin debit when the membership transaction fails', async () => {
    // Arrange: tier price 100; make the membership $transaction throw.
    // Act: expect purchaseVip to reject.
    // Assert: walletService.debit was called INSIDE the tx (with a tx arg) and
    // the thrown tx means no committed debit — assert the debit participates in
    // the same $transaction (spy receives a truthy 2nd arg), and purchaseVip rejects.
    await expect(service.purchaseVip({ userId: 'u1', level: 1 })).rejects.toThrow();
    expect(walletDebit).toHaveBeenCalledWith(expect.any(Object), expect.anything());
  });

  it('uses a deterministic idempotency key (no Date.now) for renew', async () => {
    await service.renewVip('u1');
    const key = walletDebit.mock.calls[0][0].idempotencyKey as string;
    expect(key).toBe(`vip:renew:u1:${MEMBERSHIP_LEVEL}:${MEMBERSHIP_EXPIRY_ISO}`);
    expect(key).not.toMatch(/\d{13}/); // no epoch-ms timestamp
  });
});
```

- [ ] **Step 2: Run it, verify it fails.** `pnpm test -- vip-subscription.service.spec.ts` → FAIL (debit currently called outside the tx with a `Date.now()` key).

- [ ] **Step 3: Refactor `purchaseVip`.** Move the debit inside the `$transaction`, pass `tx`, use the deterministic key. Result:

```ts
      const durationDays = tier.durationDays || 30;
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + durationDays * 86400 * 1000);

      // 3+4. Debit and membership writes are ONE atomic transaction.
      const membership = await this.prisma.$transaction(async (tx) => {
        if (coinCost > BigInt(0)) {
          await this.walletService.debit(
            {
              userId,
              currency: 'GOLD',
              amount: Number(coinCost),
              reason: WalletTxnReason.VIP_PURCHASE,
              idempotencyKey: `vip:purchase:${userId}:${level}:${existing?.expiresAt?.toISOString() ?? 'new'}`,
              metadata: { level, tierId: tier.id },
            },
            tx,
          );
        }

        const createdSub = await tx.vipSubscription.create({ /* unchanged data */ });
        const m = await tx.vipMembership.upsert({ /* unchanged data */ });
        await tx.vipHistory.create({ /* unchanged data */ });
        return m;
      });
```

(`coinCost` and `tier` are computed before the tx as today; `existing` is the membership fetched at step 2 of the current method.)

- [ ] **Step 4: Apply the same pattern to `renewVip`, `upgradeVip`, `giftVip`.** Each: move its `walletService.debit(...)` inside its existing `$transaction`, pass `tx`, and swap the `Date.now()` key for the deterministic key above. For `giftVip`, add before the tx: `const existingRecipient = await this.prisma.vipMembership.findUnique({ where: { userId: recipientUserId } });` and use it in the key.

- [ ] **Step 5: Run tests + regression.** `pnpm test -- vip` → PASS. Confirm existing VIP specs green.

- [ ] **Step 6: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green.

---

## Task 3: Gift double-pay — split by context (Defect 2)

**Files:**
- Modify: `src/modules/video-rooms/services/video-room-gift-context.handler.ts:153-159`
- Modify: `src/modules/revenue/services/revenue-event.service.ts:31-48`
- Verify/Modify: `src/modules/gifts/events/gift.events.ts` (ensure `GiftSentEvent` payload carries `contextType`)
- Test: `src/modules/revenue/services/revenue-event.service.spec.ts`, and a gift regression assertion

**Interfaces:**
- Consumes: `GIFT_EVENTS.SENT` event with payload `{ transactionId, receiverId, contextType, contextId, totalCoinValue }`.
- Produces: room/live gifts pay the receiver ONCE via the Revenue split; direct/DM/profile gifts pay ONCE via the gift handler.

- [ ] **Step 1: Confirm the event payload.** Read `src/modules/gifts/events/gift.events.ts`. Confirm `GiftSentEvent`/`GIFT_EVENTS.SENT` payload includes `contextType` (a `GiftContextType`). If it is missing, add it to the payload type AND to where `gift.service.ts` constructs the event (internal event only — not a REST/socket contract). Note the enum values: `AUDIO_ROOM`, `VIDEO_ROOM`, `LIVE`, and direct/DM/profile variants.

- [ ] **Step 2: Write the failing tests.**

```ts
// revenue-event.service.spec.ts
describe('RevenueEventService.handleGiftSent — context gating', () => {
  it('distributes host revenue for a VIDEO_ROOM gift', async () => {
    await service.handleGiftSent({
      transactionId: 't1', receiverId: 'host1',
      contextType: 'VIDEO_ROOM', contextId: 'r1', totalCoinValue: '100',
    });
    expect(processGiftRevenue).toHaveBeenCalledTimes(1);
  });

  it('does NOT distribute host revenue for a DIRECT_MESSAGE gift', async () => {
    await service.handleGiftSent({
      transactionId: 't2', receiverId: 'u2',
      contextType: 'DIRECT_MESSAGE', contextId: 'dm1', totalCoinValue: '100',
    });
    expect(processGiftRevenue).not.toHaveBeenCalled();
  });

  it('does NOT default a missing context to AUDIO_ROOM', async () => {
    await service.handleGiftSent({
      transactionId: 't3', receiverId: 'u3', contextId: 'x', totalCoinValue: '100',
    });
    expect(processGiftRevenue).not.toHaveBeenCalled();
  });
});
```

```ts
// video-room-gift-context.handler unit test
it('room gifts credit the receiver 0 via the gift path (revenue owns host payout)', () => {
  expect(handler.economics({} as any)).toEqual({ receiverEarningsBps: 0 });
});
```

- [ ] **Step 3: Run them, verify they fail.** `pnpm test -- revenue-event.service.spec.ts video-room-gift-context` → FAIL (revenue currently defaults context and always distributes; handler returns non-zero).

- [ ] **Step 4: Fix the video-room handler.** Replace `economics` in `video-room-gift-context.handler.ts`:

```ts
  /**
   * Room gifts do NOT pay the receiver via the gift path. In a room/live
   * context the receiver (host) is paid ONCE by the configurable Revenue split
   * (RevenueEventService → RevenueDistributionService). Returning 0 here — like
   * the AUDIO_ROOM handler — prevents the double-pay where both credited EARNINGS.
   */
  economics(_req: GiftContextRequest): GiftEconomics {
    return { receiverEarningsBps: 0 };
  }
```

(Remove the now-unused `creatorEarningRatePercent` config read from this method. If `this.config`/`ConfigService` becomes unused in the file, drop the import/injection too; otherwise leave it.)

- [ ] **Step 5: Gate revenue to host contexts.** In `revenue-event.service.ts`, replace `handleGiftSent` so it reads the real context and only distributes for room/live contexts:

```ts
  private static readonly HOST_CONTEXTS = new Set(['AUDIO_ROOM', 'VIDEO_ROOM', 'LIVE']);

  async handleGiftSent(payload: any) {
    const giftTxnId = payload.transactionId;
    const hostId = payload.receiverId;
    const contextType = payload.contextType; // no AUDIO_ROOM default
    const contextId = payload.contextId;
    const totalCoinValue = BigInt(payload.totalCoinValue);

    if (!giftTxnId || !hostId || totalCoinValue <= BigInt(0)) return;
    if (!contextType || !RevenueEventService.HOST_CONTEXTS.has(contextType)) return; // direct/DM/profile → gift path owns it

    const result = await this.distributionService.processGiftRevenue({
      giftTxnId, hostId, contextType, contextId, totalCoinValue,
    });
    // …unchanged publish block…
  }
```

- [ ] **Step 6: Wallet regression — assert single credit.** Add/extend a gift-send spec asserting a video-room gift produces exactly ONE receiver `EARNINGS` credit (the revenue split), not two. Follow the existing `gift.service` spec harness. Assert the audio-room path is unchanged (still single credit) and a DM gift credits once via the gift handler with no revenue credit.

- [ ] **Step 7: Run tests + regression.** `pnpm test -- gift revenue video-room-gift` → PASS.

- [ ] **Step 8: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green. Add a one-line note to the plan's "Mobile follow-ups" (below) that the video-room send-response earnings field now reads 0 at send time.

---

## Task 4: Remove duplicate `POST /gifts/send` (Defect 1)

**Files:**
- Modify: `src/modules/gifts/controllers/gifts.controller.ts` (remove the `sendGift` route + now-dead imports)
- Test: `src/modules/gifts/controllers/gifts.controller.spec.ts` (create if absent)

**Interfaces:**
- Produces: exactly one `POST /gifts/send` route (owned by `GiftController` → `GiftService`). `GiftsController` keeps `catalog`, `categories`, `search`, `popular`, `my-history`, `inventory`, `catalog/:id`.

- [ ] **Step 1: Write the failing test.** Assert `GiftsController` no longer defines a `sendGift` handler (the send route is owned solely by `GiftController`).

```ts
import { GiftsController } from './gifts.controller';
it('GiftsController does not expose a sendGift handler (single send path via GiftController)', () => {
  expect((GiftsController.prototype as any).sendGift).toBeUndefined();
});
```

- [ ] **Step 2: Run it, verify it fails.** `pnpm test -- gifts.controller.spec.ts` → FAIL (`sendGift` still defined).

- [ ] **Step 3: Remove the route.** In `gifts.controller.ts`, delete the entire `sendGift` method (lines ~77-88) with its decorators. Then remove imports that become unused: `Body`, `Post`, `HttpCode`, `HttpStatus`, `UseInterceptors`, `AuditLogAction`, `AuditLogInterceptor`, `SendGiftDto`, and the `transactionService` constructor param + its `GiftTransactionService` import — **only if** no other method in the file uses them (verify each: `RequirePermissions` and `CurrentUser` are still used by `my-history`; `UseGuards`/`RbacPermissionsGuard`/`ApiBearerAuth` still used). Do NOT delete `GiftTransactionService` the class.

- [ ] **Step 4: Run test + build.** `pnpm test -- gifts.controller.spec.ts` → PASS. `pnpm build` (or `tsc` via lint) to confirm no unused-import/compile errors.

- [ ] **Step 5: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green. Manually confirm `GiftController`'s `POST /gifts/send` still maps and runs the `GiftService` path.

---

## Task 5: Consolidate permission guards (Defect 5)

**Files:**
- Modify (10): `src/modules/{enterprise-rankings/controllers/ranking.controller.ts, vip/controllers/vip.controller.ts, tasks/controllers/task.controller.ts, achievements/controllers/achievement.controller.ts, notification/controllers/notification-center.controller.ts, referrals/controllers/referral.controller.ts, admin-dashboard/controllers/dashboard.controller.ts, enterprise-events/controllers/event.controller.ts, super-admin/controllers/super-admin-workforce.controller.ts, super-admin/controllers/super-admin-configuration.controller.ts}`
- Delete: `src/common/guards/permission.guard.ts` (after references are gone)
- Test: one guard-behavior spec per migrated controller (or a shared spec)

**Interfaces:**
- Target pattern (already used by 21 sites, e.g. `gifts.controller.ts:80-81`):
  `@UseGuards(JwtAuthGuard, RbacPermissionsGuard)` + `@RequirePermissions('<perm>')`, importing `RbacPermissionsGuard` from `src/modules/authorization/guards/rbac-permissions.guard` and `RequirePermissions` from `src/modules/authorization/decorators/authorization.decorators`.

- [ ] **Step 1: Confirm SUPER_ADMIN bypass.** Read `rbac-permissions.guard.ts` and the policy/permission resolver. Confirm `SUPER_ADMIN` is granted all permissions (the deleted `common/PermissionsGuard` short-circuited on it at `:24`). If the DB guard does NOT already bypass SUPER_ADMIN, STOP and surface this — do not silently drop the bypass.

- [ ] **Step 2: Write the failing/behavior test (per controller or shared).** For a representative migrated controller (e.g. `dashboard.controller.ts`):

```ts
it('denies a user whose DB permission was revoked even with a stale token claim', async () => {
  // RbacPermissionsGuard resolves from DB (revoked) → 403, regardless of token claims.
  rbacResolve.mockResolvedValue([]); // no permissions in DB
  await expect(guard.canActivate(ctxWithClaims(['dashboard.view']))).resolves.toBe(false);
});
it('grants SUPER_ADMIN blanket access', async () => {
  await expect(guard.canActivate(ctxWithRoles(['SUPER_ADMIN']))).resolves.toBe(true);
});
```

- [ ] **Step 3: Run it, verify it fails/represents the gap.** `pnpm test -- <controller>.spec.ts`.

- [ ] **Step 4: Migrate each controller.** In each of the 10 files: replace the import of `PermissionsGuard` from `src/common/guards/permission.guard` with `RbacPermissionsGuard` from the authorization module; replace it in every `@UseGuards(...)` (keep `JwtAuthGuard` first); ensure `@RequirePermissions(...)` uses the authorization-module decorator (some already do). Keep the exact permission strings unchanged.

- [ ] **Step 5: Delete the old guard.** Run `grep -rn "common/guards/permission.guard\|from.*PermissionsGuard" src/`. When zero references remain, delete `src/common/guards/permission.guard.ts` and remove any barrel re-export.

- [ ] **Step 6: Run full suite.** `pnpm test` → PASS. Verify authorized roles pass and unauthorized get 403 across migrated controllers.

- [ ] **Step 7: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green.

---

## Task 6: DLQ retry/replay actually re-enqueue (Defect 6)

**Files:**
- Modify: `src/infra/queue/queue.service.ts` (add `getQueue(name)` accessor if absent)
- Modify: `src/infra/queue/dlq.service.ts:42-54`
- Test: `src/infra/queue/dlq.service.spec.ts`

**Interfaces:**
- Consumes: `QueueService.getQueue(name: string): Queue | undefined` (map built at `queue.service.ts:31`).
- Produces: `retryJob`/`replayJob` re-add the job to its BullMQ queue and remove the DLQ record on success.

- [ ] **Step 1: Add the accessor.** In `queue.service.ts`, if there is no public getter over the name→Queue map, add: `getQueue(name: string): Queue | undefined { return this.queues.get(name); }` (use the existing map field name).

- [ ] **Step 2: Write the failing test.** Extend `dlq.service.spec.ts`; mock a `QueueService` whose `getQueue` returns a queue with a spy `add`.

```ts
it('retryJob re-enqueues the job to its queue and clears the DLQ record', async () => {
  const add = jest.fn().mockResolvedValue({ id: 'new' });
  queueService.getQueue.mockReturnValue({ add } as any);
  redisMock.hget.mockResolvedValue(JSON.stringify({
    id: 'job-1', queueName: 'gift-processing', name: 'send', data: { a: 1 },
  }));
  const ok = await service.retryJob('job-1');
  expect(ok).toBe(true);
  expect(add).toHaveBeenCalledWith('send', { a: 1 });
  expect(redisMock.hdel).toHaveBeenCalledWith('dlq:failed_jobs', 'job-1');
});

it('returns false for an unknown job id', async () => {
  redisMock.hget.mockResolvedValue(null);
  expect(await service.retryJob('missing')).toBe(false);
});
```

- [ ] **Step 3: Run it, verify it fails.** `pnpm test -- dlq.service.spec.ts` → FAIL (`add`/`hdel` never called).

- [ ] **Step 4: Implement.** Inject `QueueService` into `DLQService`; re-enqueue in both methods (factor a private helper):

```ts
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly queueService: QueueService,
  ) {}

  private async requeue(id: string, verb: 'Retry' | 'Replay'): Promise<boolean> {
    const job = await this.getJobById(id);
    if (!job) return false;
    const queue = this.queueService.getQueue(job.queueName);
    if (!queue) {
      this.logger.error(`${verb}: unknown queue [${job.queueName}] for DLQ job [${id}]`);
      return false;
    }
    await queue.add(job.name, job.data);
    await this.redis.hdel(DLQ_HASH_KEY, id);
    this.logger.log(`${verb}ed DLQ job [${id}] → queue [${job.queueName}]`);
    return true;
  }

  async retryJob(id: string): Promise<boolean> { return this.requeue(id, 'Retry'); }
  async replayJob(id: string): Promise<boolean> { return this.requeue(id, 'Replay'); }
```

Ensure `QueueService` is provided/exported so `DLQService` (in `infra.module.ts`) can inject it; if there is a circular-dependency risk between `QueueService` and `DLQService`, resolve with `forwardRef` or by moving the accessor to the module that owns the queue map. Verify `pushToDLQ` producers do not depend on `DLQService`→`QueueService`→`DLQService` cycles.

- [ ] **Step 5: Run tests + regression.** `pnpm test -- dlq` → PASS.

- [ ] **Step 6: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green.

---

## Task 7: DR reads the correct S3 env var (Defect 7)

**Files:**
- Modify: `src/infra/ops/disaster-recovery.service.ts:37`
- Test: `src/infra/ops/disaster-recovery.service.spec.ts` (create if absent)

- [ ] **Step 1: Write the failing test.** Mock `ConfigService.get` to return a value only for `'S3_BUCKET'`; assert the DR S3 check reports healthy (not WARNING).

```ts
it('reads S3_BUCKET (not AWS_S3_BUCKET) for the S3 DR check', async () => {
  config.get.mockImplementation((k: string) => (k === 'S3_BUCKET' ? 'soulzaa-media' : undefined));
  const result = await service.checkBackupHealth(); // use the actual method name
  expect(result.s3).not.toBe('WARNING'); // healthy when bucket configured
});
```

- [ ] **Step 2: Run it, verify it fails.** FAIL (service reads `AWS_S3_BUCKET` → undefined → WARNING).

- [ ] **Step 3: Fix the var name.** `disaster-recovery.service.ts:37` → `const s3Bucket = this.config.get<string>('S3_BUCKET');`.

- [ ] **Step 4: Run test.** PASS.

- [ ] **Step 5: Verification checkpoint.** `pnpm lint` + `pnpm boundaries` green.

---

## Task 8: k8s NetworkPolicy allows UDP DNS (Defect 8)

**Files:**
- Modify: `k8s/04-ingress-netpol.yaml` (egress ports, near `:71-76`)

- [ ] **Step 1: Add the UDP/53 rule.** In the DNS egress `ports` list, add a UDP entry alongside the existing TCP/53:

```yaml
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53   # DNS (TCP fallback for large responses)
```

- [ ] **Step 2: Validate the manifest.** Run `kubectl apply --dry-run=client -f k8s/04-ingress-netpol.yaml` (or a YAML linter if no cluster). Expected: valid; both UDP/53 and TCP/53 present under egress.

- [ ] **Step 3: Verification checkpoint.** `grep -A2 "port: 53" k8s/04-ingress-netpol.yaml` shows both protocols. (No app tests apply.)

---

## Mobile follow-ups (surface to product/mobile team, not code)

- **Defect 2:** For video-room gift sends, the send-response "coins credited to receiver's EARNINGS" is now `0` at send time (revenue arrives asynchronously via the Revenue listener — identical to how audio-room gifts already behave). Any "you earned N" UI on video-room sends must read earnings from the wallet/earnings endpoint, not the send response.

## Self-Review (completed)

- **Spec coverage:** all 8 spec defects → Tasks 1–8. ✔
- **Placeholder scan:** no TBD/TODO; each code step shows real code; tests are concrete. The two "verify" steps (event payload `contextType`; SUPER_ADMIN bypass) are bounded confirmations with defined fallbacks, not open placeholders. ✔
- **Type consistency:** `validateSufficientBalance(wallet, amount, currency?)` defined in Task 1, consumed in Task 1 step 4; `getQueue(name)` defined + consumed in Task 6; `IWalletService.debit(input, tx?)` used in Task 2 matches the verified interface. ✔
- **Sequencing:** wallet foundation (Task 1) precedes VIP debit (Task 2); gift split (Task 3) precedes route removal (Task 4). ✔
