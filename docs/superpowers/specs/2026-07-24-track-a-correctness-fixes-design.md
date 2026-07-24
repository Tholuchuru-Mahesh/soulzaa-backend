# Track A — Correctness Fixes (Design Spec)

- **Date:** 2026-07-24
- **Status:** Approved (design) — pending spec review
- **Scope:** Eight confirmed correctness/security/economic defects surfaced by the 2026-07-24 PRD-vs-code audit. **Bug fixes only — no new features, no P0-blocker work.**
- **Related:** `soulzaa-production-readiness-2026-07-24` (audit), Volume 3 (economy) of `production.txt`.

## Hard constraints (from product owner)

1. **TDD-first.** For every defect, write a **failing regression test that reproduces the bug first**, then fix until green. No fix merges without a test that would have caught it.
2. **Preserve contracts.** No changes to REST request/response **schemas**, endpoint paths, or Socket.IO **event names/payload shapes**. (Corrected *values* that result directly from fixing an identified defect are in scope and are called out per-item under "Contract impact".)
3. **No scope creep.** No behavioral change outside the eight identified defects. No opportunistic refactors.
4. **Wallet fully covered.** Every wallet-touching change (defects 2, 3, 4) must have regression tests asserting exact balances/ledger rows to prevent financial inconsistency.

## Working method

- Verify-first, riskiest-economic-item-first sequencing (below).
- Project runs on `prisma db push` with **no migrations** and is **working-tree-only (no git commits without explicit approval)** — do not commit or run migrations. None of these fixes require a schema change.
- Run `pnpm test` (unit) + affected `*.spec.ts` after each fix; `pnpm lint` and `pnpm boundaries` must stay green.

---

## Defect 1 — Duplicate `POST /gifts/send` route

**Evidence:** `gifts.module.ts:26` registers both `GiftController` (`@Controller('gifts')` + `@Post('send')` → `GiftService.sendGift`) and `GiftsController` (`@Controller('gifts')` + `@Post('send')` → `GiftTransactionService.sendGift`). Same method+path, divergent economics; the second is dead/shadowed and applies a different (flat-transfer, no-events) money model.

**Root cause:** Two controllers own the same route; only one wins by registration order, silently.

**Fix:** `GiftService` is the canonical send engine (events, treasure routing, EXP, leaderboards, locks, multi-receiver, idempotency). Remove `@Post('send')` from `GiftsController`. **Keep** `GiftsController`'s unique read routes (`catalog`, `categories`, `search`, `popular`, `inventory`, `my-history`). Result: exactly one `POST /gifts/send`.

**Contract impact:** `POST /gifts/send` request/response shape is unchanged (both used `SendGiftDto`). The surviving handler is `GiftService`'s. No path/schema change. `GiftTransactionService.sendGift` becomes unreferenced by HTTP — leave the service in place (still used internally) unless a test proves it fully dead; do not delete in this track.

**Tests:** Regression test asserting only one route resolves and it runs the `GiftService` path (events emitted, EARNINGS/revenue behavior per defect 2). Controller test that the removed route no longer maps.

---

## Defect 2 — Room + direct gifts double-pay the receiver (coin leak) · CRITICAL

**Evidence:**
- `gift.service.ts:270-287` credits `receiverId` `EARNINGS` = `perReceiver × receiverEarningsBps/10000` (idem key `gift-credit:{k}:{receiver}`).
- `gift.service` publishes `GIFT_EVENTS.SENT`; `revenue-event.service.ts:17,33,42` subscribes, sets `hostId = payload.receiverId`, **defaults `contextType` to `'AUDIO_ROOM'`**, and calls `RevenueDistributionService.processGiftRevenue` → credits the **same wallet** `EARNINGS` = revenue split (default host 50%, `revenue-configuration.service.ts:29`), idem key `host-earning:{giftTxnId}`.
- Handlers: `audio-room-gift-context.handler.ts:100` → `receiverEarningsBps: 0` (**already correct** — revenue pays, gift does not). `video-room-gift-context.handler.ts:158` → `receiverEarningsBps: rate×100` (**non-zero → double-pay**). Direct/DM/profile contexts also non-zero, and Revenue fires for them too (via the `'AUDIO_ROOM'` default) → **double-pay**.

**Net current behavior:** audio-room gifts pay once (✓); **video-room and direct/DM/profile gifts pay the receiver twice** (gift rate% + revenue 50%). Idempotency keys differ, so nothing dedupes them.

**Decision (product owner): "split by context".**
- **Room/live contexts (AUDIO_ROOM, VIDEO_ROOM, LIVE):** receiver earns **once via the configurable Revenue split** (host/platform/agency/referral). Gift context handler returns `receiverEarningsBps: 0`.
- **Direct/DM/profile contexts:** receiver earns **once via the gift's own rate** (`GiftService`). Revenue does **not** fire.

**Fix:**
1. `video-room-gift-context.handler.ts` `economics()` → return `receiverEarningsBps: 0` (align with audio-room; Revenue owns room-host payout). Keep any rate config wiring intact but unused for the credit, or remove cleanly if it has no other reader.
2. `revenue-event.service.ts` `handleGiftSent`: **remove the `|| 'AUDIO_ROOM'` default**; read the real `contextType` from the payload and process **only** for the host-context set `{AUDIO_ROOM, VIDEO_ROOM, LIVE}`. For any other context, return without crediting. (Confirm `GiftSentEvent`/`GIFT_EVENTS.SENT` payload carries `contextType`; if not, thread it through the event — no external contract change, internal event only.)
3. Direct/DM/profile handlers keep their non-zero `receiverEarningsBps` (unchanged).

**Implementation checkpoints (resolve during impl, do not defer past first commit):**
- Confirm no **third** video-room host-payout path exists (VR-14 was read-model/observer per audit; analytics `hostEarnings` fields at `video-room-analytics-query.service.ts:96` are reporting, not crediting — verify no wallet `credit` in the video-room gift path besides `GiftService`).
- Confirm the `GIFT.SENT` event payload includes `contextType` (thread it if missing).

**Contract impact (call-out):** For **video-room** gift sends the response field "coins credited to receiver's EARNINGS" (`video-room-gift-response.dto.ts:24`) becomes **0 at send time**, with the real earning arriving asynchronously via the Revenue listener — **this is exactly how audio-room gifts already behave**, so it aligns video rooms to the established pattern rather than introducing a new shape. Field/schema unchanged. **Flag to the mobile team** so any "you earned N" UI on video-room sends reads earnings from the wallet/revenue path (as audio rooms do), not the send response.

**Tests (wallet-critical — assert exact balances + ledger rows):**
- Video-room gift: receiver EARNINGS increases by **exactly the revenue split once** (not rate% + 50%). Exactly one `EARNINGS` credit ledger row for the receiver per gift.
- Audio-room gift: unchanged (regression guard — still single revenue credit).
- Direct/DM gift: receiver credited **once** via gift rate; **no** revenue credit; Revenue listener is a no-op for that context.
- Idempotent replay of the same `GIFT.SENT` does not double-credit.

---

## Defect 3 — Currency-scoped balance not enforced on debit

**Evidence:** `wallet-transaction.service.ts` maintains `availableBalance` as an aggregate updated in lockstep with the matching sub-balance on every credit (`:76-80`) and debit (`:173-178`). `wallet-validation.service.ts:47` `validateSufficientBalance` checks only `wallet.availableBalance`. So a GOLD debit passes if `availableBalance` (gold+free+earnings) suffices, even when `goldBalance` is insufficient → **FREE/EARNINGS coins satisfy a GOLD-only debit and `goldBalance` can go negative.** PRD (Vol 3): "Free Coins cannot purchase gifts / VIP / Treasure."

**Root cause:** Validation uses the aggregate pool, not the currency-specific sub-balance.

**Fix:** Make `validateSufficientBalance` **currency-aware** — validate against the sub-balance matching the debit currency (`GOLD → goldBalance`, `FREE → freeBalance`, `EARNINGS → earningsBalance`), defaulting to `GOLD` where the debit does. Thread the debit `currency` into the validation call in the debit path (`wallet-transaction.service.ts` debit). This is a **validation-only change** (sub-balances are already authoritatively maintained); no balance-model change, no schema change.

**Contract impact:** None (internal). A previously-wrongly-allowed cross-currency debit now correctly throws `Insufficient …balance` (existing exception type/shape).

**Tests (wallet-critical):**
- GOLD debit with `goldBalance=0, freeBalance=100` → **rejected** (was wrongly allowed); `goldBalance` never goes negative.
- GOLD debit with sufficient `goldBalance` → succeeds; correct sub-balance + aggregate decremented.
- FREE and EARNINGS debits validate against their own sub-balances.
- Downstream callsites still pass for legitimate GOLD spends (gifts, VIP, treasure, cosmetics).

---

## Defect 4 — VIP purchase non-atomic + non-idempotent

**Evidence:** `vip-subscription.service.ts` — coin `debit` at `:69` runs **before/outside** the membership `$transaction` at `:84`; all four idempotency keys embed `Date.now()` (`:74` purchase, `:170` renew, `:246` upgrade, `:326` gift). So a retried request mints a **new** idem key → **double charge**; and a debit that succeeds while the membership tx fails leaves the user charged with no membership.

**Root cause:** Non-deterministic idem key + debit not in the same transaction as the membership write.

**Fix:**
1. Replace `Date.now()` in all four idem keys with a **deterministic** key (scope to a stable purchase identifier: e.g. `vip:purchase:{userId}:{level}:{periodOrOrderId}` — reuse the request/order id if one exists, else a caller-supplied idempotency token; must be stable across retries of the same logical purchase).
2. Move the wallet `debit` **inside** the membership `$transaction` (wallet `debit` already accepts a `tx` — same pattern `GiftService` uses for `credit`) so debit + membership are all-or-nothing. Keep the existing `vip:purchase:{userId}` lock.

**Contract impact:** None (internal). Same endpoints, same response.

**Tests (wallet-critical):**
- Retried identical purchase → **charged once**, one membership.
- Membership write failure → debit **rolled back** (no coins lost, no membership).
- Renew/upgrade/gift paths each: idempotent on retry, atomic on failure.

---

## Defect 5 — Two permission-enforcement paths (privilege drift)

**Evidence:** `common/guards/permission.guard.ts:26` `PermissionsGuard` reads `user?.permissions` from **JWT claims** (stale until token refresh); short-circuits on `SUPER_ADMIN`. Ten controllers use it — incl. `admin-dashboard/controllers/dashboard.controller.ts`, `super-admin-workforce.controller.ts`, `super-admin-configuration.controller.ts`, `vip`, `tasks`, `achievements`, `notification-center`, `referrals`, `enterprise-rankings`, `enterprise-events`. The DB-backed, Redis-cached `authorization/guards/rbac-permissions.guard.ts` is used by 21 sites. A demoted user keeps access until their token refreshes.

**Root cause:** Divergent guards; the claim-based one trusts stale token permissions instead of the DB source of truth.

**Fix:** Standardize on `RbacPermissionsGuard` (DB-backed, already Redis-cached so per-request cost is a cache hit). Migrate the 10 claim-based controllers to `@RequirePermissions` + `RbacPermissionsGuard` (matching the decorator/guard pairing the other 21 sites use). Delete `common/guards/permission.guard.ts` once no references remain. Preserve the `SUPER_ADMIN` bypass semantics (verify `RbacPermissionsGuard`/policy engine already grants it; if not, retain an explicit equivalent).

**Contract impact:** None to request/response. Behavioral correction: permission checks reflect live DB state, not stale claims. Verify no endpoint currently *relies* on stale-claim leniency (it shouldn't).

**Tests:**
- Per migrated controller: authorized role passes, unauthorized role gets `403`.
- Privilege-drift regression: a user whose DB permission was revoked mid-session is denied even with an old token claim.
- `SUPER_ADMIN` retains blanket access.

---

## Defect 6 — DLQ retry/replay are no-ops

**Evidence:** `infra/queue/dlq.service.ts:42-54` `retryJob`/`replayJob` fetch the record, log, and `return true` **without re-enqueueing** to BullMQ. Failed jobs cannot be recovered.

**Fix:** Re-add the job to its target BullMQ queue (by `job.queueName` + stored payload/opts) via the queue registry, then return real success/failure (and remove/mark the DLQ record on successful re-enqueue, matching `deleteJob` semantics). No signature/contract change.

**Tests:** `retryJob`/`replayJob` actually enqueue to the correct queue with the original payload; return `false` for unknown id; DLQ record handled consistently after re-enqueue.

---

## Defect 7 — Disaster-recovery S3 check reads wrong env var

**Evidence:** `infra/ops/disaster-recovery.service.ts:37` reads `AWS_S3_BUCKET`; the validated/actual variable is `S3_BUCKET` (`config/env.validation.ts:145`). `s3Bucket` is always `undefined` → DR S3 check permanently WARNs.

**Fix:** Read `S3_BUCKET` (the validated name). One-line change.

**Tests:** DR check reports healthy when `S3_BUCKET` is set; unit test asserts the service reads the correct key.

---

## Defect 8 — k8s NetworkPolicy blocks UDP DNS

**Evidence:** `k8s/04-ingress-netpol.yaml:74-75` egress allows port 53 **TCP only**; DNS resolvers query **UDP/53** first → pods may fail to resolve RDS/Redis/S3/vendor hosts.

**Fix:** Add a `protocol: UDP, port: 53` egress rule alongside the existing TCP/53 rule (keep TCP for large responses). Manifest-only change.

**Tests:** Manifest validation (`kubectl --dry-run`/yaml lint) confirms both UDP and TCP 53 egress present. (No app unit test; verified at manifest level.)

---

## Sequencing

1. **Economic integrity (2, 3, 4, 1)** — highest value, wallet-critical, most test care.
2. **Security (5)** — guard consolidation.
3. **Infra (6, 7, 8)** — low-risk, mechanical.

Each item: failing test → fix → green → lint/boundaries clean, before moving on.

## Out of scope (explicit)

- All P0 blockers (Firebase key, payment integration, migrations baseline, SMS/email, RDS backups).
- Any new feature (Live Streaming, moderation console, achievements/tasks wiring).
- Deleting `GiftTransactionService` (only its HTTP route is removed).
- Refactors unrelated to the eight defects.

## Done criteria

- 8 defects fixed, each with a regression test that fails before / passes after.
- Full `pnpm test` green; `pnpm lint` (`--max-warnings 0`) and `pnpm boundaries` green.
- Wallet regression tests assert exact balances + ledger-row counts for defects 2–4.
- No REST/Socket.IO schema or path changes; the one behavioral value change (defect 2, video-room send-response earnings) documented and flagged to mobile.
