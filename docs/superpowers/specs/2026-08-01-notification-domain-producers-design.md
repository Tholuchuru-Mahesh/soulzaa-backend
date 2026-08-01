# Notification Domain Producers — Design

**Date:** 2026-08-01
**Status:** Approved, pending implementation plan
**Repos:** `soulzaa-backend`, `soulzaa-mobile`

---

## 1. Context

Soulzaa already has a centralised notification system. This design does **not** create one.

What exists today (verified, not assumed):

| Concern | Where |
|---|---|
| Notification module (43 files, ~3,650 LOC) | `src/modules/notification/` |
| Persistence | `prisma/schema/notification.prisma` — 11 models incl. `Notification`, `NotificationPreference`, `NotificationTemplate`, `NotificationStatistics`, `NotificationAudit` |
| Real-time | Socket.IO `/notifications` namespace, per-user rooms, `notification-socket.listener.ts` |
| Badge | every socket payload carries `unreadCount`, so badge and list cannot drift |
| Queues | BullMQ `notifications` queue; device-owned `push` queue with `push.processor.ts`, retry → dead-letter |
| Push transport | `fcm-push.provider.ts`, `apns-push.provider.ts`, `console-push.provider.ts`, registry + dispatcher, dead-token retirement |
| Preferences | master switch + 13 category switches + sound/vibration/showPreview/mutedUntil; server-side preview redaction; `SECURITY` deliberately non-optional |
| Client | `soulzaa-mobile/lib/features/notifications/` — 47 files: repositories, controllers, providers, feed + settings screens, tile, FCM bootstrap, background spool, deep-link router |

The "no per-module notification logic" rule is already honoured: `video-room-notification.service.ts` is a thin adapter that delegates to the central `NotificationService`.

**The actual gap is producer coverage.** Only five producers publish into the system:

- `social` — followed, friend request, friend accepted, invitation sent
- `chat` — message sent
- `gifts` — gift sent
- `calls` — missed call push
- `video-rooms` — room / seat / PK / treasure

`NotificationType` has ~40 values. Whole domains emit nothing.

---

## 2. Goal

Make Wallet, Games, VIP, Family, and System/Security publish into the existing notification system, following the established listener pattern, without duplicating notification logic inside those modules.

### Non-goals

- Rebuilding or refactoring the notification module. It works; leave it alone.
- **Live streaming.** `src/modules/live-streaming/` is an unimplemented stub — 38 LOC, every barrel empty (`/** live-streaming events — empty until the module is implemented. */ export {};`). There is no domain to emit "creator went live". This is **blocked on that module existing**, not descoped by preference. Same for `payments`.
- Audio-room, chat, and social notification breadth beyond what exists. Separate effort.

---

## 3. Contract change: four new push categories

New categories: `WALLET`, `GAME`, `VIP`, `FAMILY`. (`LIVE` is deliberately omitted — see non-goals.)

A push category is a **three-way contract**. All three change together or pushes break:

| File | Change |
|---|---|
| `src/modules/device/interfaces/push.constants.ts` | 4 values in `PUSH_CATEGORIES`; 4 entries in `TUNABLE_CHANNEL_PREFIX` (`soulzaa_wallet`, `soulzaa_games`, `soulzaa_vip`, `soulzaa_family`) |
| `prisma/schema/notification.prisma` | 4 columns on `NotificationPreference`: `walletEvents`, `gameEvents`, `vipEvents`, `familyEvents`, all `Boolean @default(true)` — requires a migration |
| `soulzaa-mobile/.../core/services/firebase/push_channels.dart` | same 4 in `PushCategory`, `forCategory()`, and `all` |

### Why this is the riskiest part

The existing code states the hazard plainly:

> Android silently drops a push naming a channel the app never created, so the client registers **every** id the server can select, at boot, before any push can arrive.

Server-side, `ALL_PUSH_CHANNEL_IDS` is *derived* from `TUNABLE_CHANNEL_PREFIX`, so it stays correct automatically. The Flutter list is **hand-written**, so it can drift.

**Mitigation:** a test asserts the server's `ALL_PUSH_CHANNEL_IDS` and Flutter's `PushChannels.all` contain identical id sets. Without this, a typo produces pushes that vanish with no error anywhere.

### Deployment ordering

Server first is safe. `NotificationPreference` defaults are `true`, and an old client ignores unknown categories in the payload. But **pushes on the four new channels will not display until the mobile release lands**. Either ship mobile first, or accept that new-category pushes are in-app/socket-only during the gap.

---

## 4. New `NotificationType` values

Append-only. Never reorder or remove — the enum is persisted.

```
Wallet    RECHARGE_SUCCESS, WITHDRAWAL_APPROVED, WITHDRAWAL_REJECTED,
          REFUND_PROCESSED, COINS_RECEIVED, COINS_DEDUCTED
Games     GAME_MATCH_FOUND, GAME_STARTED, GAME_WON, GAME_LOST, GAME_OPPONENT_LEFT
VIP       VIP_ACTIVATED, VIP_RENEWED, VIP_EXPIRING, VIP_EXPIRED
Family    FAMILY_MEMBER_JOINED, FAMILY_MEMBER_LEFT, FAMILY_REMOVED
Security  SECURITY_NEW_LOGIN, SECURITY_PASSWORD_CHANGED
```

`FAMILY_INVITE`, `GAME_INVITE`, `ROOM_INVITE`, `EVENT_INVITE`, `PK_INVITE` already exist and are produced by the social invitation listener. Not duplicated here.

---

## 5. Wallet listener — allowlist, not firehose

`WALLET_EVENTS.CREDITED` / `DEBITED` carry:

```ts
{ userId, transactionId, currency, amount, balanceAfter,
  reason: WalletTxnReason, referenceType, referenceId }
```

`reason` has **34 values**, including `CASINO_BET`, `GAME_STAKE`, `RESERVATION_HOLD`, `RESERVATION_RELEASE`. Notifying on all of them would be spam.

**Deny by default.** Only these produce a notification:

| Reason | Type | Category | Rationale |
|---|---|---|---|
| `RECHARGE` | `RECHARGE_SUCCESS` | `WALLET` | money in |
| `GIFT_REFUND`, `GAME_REFUND`, `LUCKY_PACKET_REFUND`, `CASINO_REFUND` | `REFUND_PROCESSED` | `WALLET` | money back |
| `ADMIN_CREDIT` | `COINS_RECEIVED` | `WALLET` | unexplained balance change |
| `ADMIN_DEBIT` | `COINS_DEDUCTED` | `WALLET` | unexplained balance change |
| `EVENT_REWARD`, `ATTENDANCE_REWARD`, `SPIN_WHEEL_REWARD` | `COINS_RECEIVED` | `WALLET` | earned |

**`GIFT_RECEIVE` and `GIFT_SEND` are excluded.** `gift-notification.listener.ts` already notifies the receiver on `GIFT_EVENTS.SENT`. Including them here would double-notify every single gift — this is the single most likely regression in the whole change and gets an explicit negative test.

`COINS_DEDUCTED` is limited to `ADMIN_DEBIT` only. A user spending their own coins does not need to be told they spent their own coins.

Because `reason` fully discriminates the cases, **no new events are added inside the wallet module.**

---

## 6. `NotificationGuard` — dedupe and rate limiting

There is currently **no dedupe or rate limiting anywhere in the notification module** (verified by grep). The spec requires both.

New service: `src/modules/notification/services/notification-guard.service.ts`, Redis-backed.

```ts
once(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null>
withinBudget(userId: string, category: PushCategory): Promise<boolean>
```

- `once` — Redis `SET NX EX`. A second call with the same key inside the TTL is a no-op returning `null`. Keys are natural and derived from domain ids, never from timestamps: `wallet:{transactionId}`, `game:{sessionId}:{userId}`, `vip-expiring:{userId}:{yyyy-mm-dd}`, `login:{userId}:{deviceId}`.
- `withinBudget` — token bucket per user per category, so one runaway producer cannot flood a single user's feed.

**Opt-in at the call site**, not inside `NotificationService.create()`. Two gifts in a row are two real events; a `create()` that silently no-ops would be a bug, not a feature. Existing listeners can adopt the guard incrementally.

---

## 7. Events that must be added

### Withdrawals

`WithdrawalEventService.publishWithdrawalEvent(eventName: string, payload: any)` exists but has **zero callers** — dead, untyped scaffolding.

Add typed `WITHDRAWAL_EVENTS.APPROVED` / `REJECTED` with payload classes extending `DomainEvent`, published from `withdrawal-approval.service.ts` at the status transition. Follow the `WALLET_EVENTS` file shape. The `any`-typed passthrough is replaced, not extended.

### VIP

`VipEventService` is called with **untyped string literals** — `'vip.created'`, `'vip.renewed'`, `'vip.upgraded'` — from `vip-subscription.service.ts` (4 call sites), but `VIP_EVENTS` declares only `UPGRADED`. Two events are already flowing on the bus undeclared.

Declare `CREATED` and `RENEWED` in `VIP_EVENTS` with proper payload classes, and add `EXPIRING` / `EXPIRED`. Update the call sites to use the constants.

### VIP expiry sweep

`VIP_EXPIRING` and `VIP_EXPIRED` cannot fire from a request — nothing happens when time passes. Add a BullMQ repeatable job following the existing pattern in `otp.scheduler.ts` and `enterprise-events/services/event.scheduler.ts`:

- Daily cron.
- Finds subscriptions expiring within 3 days → `VIP_EXPIRING`; newly past expiry → `VIP_EXPIRED`.
- Guarded by `vip-expiring:{userId}:{date}` so a user is not pinged every single day of the window.

---

## 8. Games listener

`GAME_EVENTS` is already rich (18 events). Subscribe to:

| Event | Type |
|---|---|
| `MATCH_FOUND` | `GAME_MATCH_FOUND` |
| `STARTED` | `GAME_STARTED` |
| `SETTLED` | `GAME_WON` / `GAME_LOST` per participant outcome |
| `FORFEITED` | `GAME_OPPONENT_LEFT` (to the remaining player) |

Lobby churn events (`LOBBY_JOINED`, `LOBBY_LEFT`, `LOBBY_MEMBER_READY`, `TURN_*`) are **not** notification-worthy — they are in-session socket traffic and the player is already looking at the screen.

Game coin payouts arrive via `GAME_PAYOUT` on the wallet, which is excluded from the wallet allowlist to avoid double-notifying alongside `GAME_WON`.

---

## 9. Family listener

`FAMILY_EVENTS` payloads are thin: `MEMBER_JOINED` carries only `{ familyId, userId }` — no actor, no member list.

**Leadership model (verified):** `Family.founderId` identifies the owner — note the schema calls it `founderId` while `FamilyCreatedEvent`'s payload calls the same person `leaderId`. `FamilyMember.role` is a plain `String @default("MEMBER")`, not an enum; the only values used in code are `'ELDER'` and `'MEMBER'`. There is no `ADMIN` role. `@@index([familyId, role])` exists, so querying officers is cheap.

"Officers" below means **the founder plus members with role `'ELDER'`**.

| Event | Type | Recipients |
|---|---|---|
| `MEMBER_JOINED` | `FAMILY_MEMBER_JOINED` | officers only |
| `MEMBER_LEFT` (`kicked: true`) | `FAMILY_REMOVED` | the removed member |
| `MEMBER_LEFT` (`kicked: false`) | `FAMILY_MEMBER_LEFT` | officers only |
| `DELETED` | `FAMILY_REMOVED` | all members |

**Fan-out cap:** notifying every member on every join is O(members) rows per join. Restricted to officers. `DELETED` is the one full fan-out, and it is rare and genuinely relevant to everyone.

Family *invitations* are already handled by the social invitation listener (`InvitationType.FAMILY` → `FAMILY_INVITE`). Not duplicated.

---

## 10. Security listener

**Revised after reading the existing code.** The obvious design — subscribe to `AUTH_EVENTS.USER_LOGGED_IN` and push an alert excluding the originating device — is wrong three times over:

1. **The push already exists.** `device.service.ts:136-151` builds a `SECURITY` login alert with `excludeDeviceId: device.id` and enqueues it on `DEVICE_JOBS.LOGIN_ALERT`, gated by the `SUSPICIOUS_LOGIN_ALERTS` flag. It deliberately bypasses `PushPolicy`, with the comment: *"A break-in alert the intruder could have silenced from inside the account is not an alert."* Pushing again would double-alert.
2. **`USER_LOGGED_IN` is the wrong signal.** It fires on *every* login. The device module alerts only on `new_device` or `country_change`, and only when the account already has another active device (`device.service.ts:112-115`).
3. **The exclusion is unreachable from here.** `PushIntent` has no `excludeDeviceId` field, so `notify()` cannot exclude a device — and `auth.service.ts:416` publishes `UserLoggedInEvent` with `deviceId: null` hardcoded anyway.

**What is genuinely missing is the durable row.** The existing alert is fire-and-forget: nothing writes a `Notification`, so a user who missed or dismissed the push has no security history in the notification centre.

| Event | Type | Row | Push |
|---|---|---|---|
| `DEVICE_EVENTS.SUSPICIOUS_LOGIN` | `SECURITY_NEW_LOGIN` | yes | **no** — `DeviceService` already pushes |
| `AUTH_EVENTS.USER_PASSWORD_CHANGED` | `SECURITY_PASSWORD_CHANGED` | yes | yes — nothing else covers it |

`SuspiciousLoginDetectedEvent` carries `{ userId, deviceId, reason, ip, country }` — everything the row needs.

`SECURITY` maps to `null` in `CATEGORY_SWITCH` and is never suppressed. The rate limiter is not applied to security events either: throttling a break-in alert defeats its purpose.

Guarded by `login:{userId}:{deviceId}` to absorb repeated detections for the same device.

---

## 11. Flutter changes

| Area | Change |
|---|---|
| `push_channels.dart` | 4 categories + channel ids, kept identical to server |
| `notification_type.dart` | 20 new type values with `unknown` fallback preserved |
| `notification_category.dart` | map new types to existing `wallet`, `games`, `vip`, `family` buckets (already present) |
| `notification_settings_screen.dart` | toggles for the 4 new preference columns |
| `deep_link_router.dart` | routes for wallet txn, game session, VIP page, family page |
| `notification_l10n.dart` | strings for the new types |

The client's `unknown` fallback means an old client meeting a new type degrades gracefully rather than crashing — that property must be preserved.

---

## 12. Testing

| Layer | Coverage |
|---|---|
| Wallet listener | each allowlisted reason maps correctly; **`GIFT_RECEIVE` produces nothing**; `CASINO_BET` / `RESERVATION_HOLD` produce nothing |
| Guard | `once` suppresses within TTL and permits after; token bucket exhausts and refills |
| Games listener | `SETTLED` yields win for winner and loss for loser; lobby events produce nothing |
| Family listener | fan-out limited to officers (founder + `'ELDER'`); kicked member gets `FAMILY_REMOVED`; a large family does not produce a row per member on join |
| VIP scheduler | expiring window boundaries; same user not notified twice in one window |
| Security listener | originating device excluded from new-login push |
| Channel parity | server `ALL_PUSH_CHANNEL_IDS` set == Flutter `PushChannels.all` set |
| Flutter | new type/category mapping; `unknown` fallback intact; deep-link routing |

Existing suites must stay green: audio rooms, video rooms, chat, wallet, games, family, social. Strict TypeScript, zero lint errors, zero analyzer warnings.

---

## 13. Risks

1. **Channel drift** — mitigated by the parity test. Without it, failure is silent.
2. **Release ordering** — server-first leaves new-category pushes undisplayed on Android until the mobile release ships. Socket/in-app delivery is unaffected.
3. **Double-notify on gifts** — the wallet allowlist is the only thing preventing it; covered by an explicit negative test.
4. **Migration** — four additive nullable-with-default booleans. Backward compatible; old server code ignores the new columns.
5. **`COINS_DEDUCTED` value** — narrowed to `ADMIN_DEBIT` only. If even that proves noisy, it is the first thing to cut.
