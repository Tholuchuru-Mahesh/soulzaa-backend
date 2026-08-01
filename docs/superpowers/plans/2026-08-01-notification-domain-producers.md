# Notification Domain Producers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Wallet, Games, VIP, Family, and Security publish into Soulzaa's existing centralised notification system, with duplicate-suppression and rate limiting.

**Architecture:** The notification module already exists and works. This plan adds *producers* only — bridge listeners inside `src/modules/notification/listeners/` that subscribe to existing domain events on `IEventBus` and call `NotificationService.create()` + `notify()`. No notification logic is added to any feature module. Four new push categories are added across a strict three-way contract (server constants, Prisma preferences, Flutter channels). A new Redis-backed `NotificationGuard` provides dedupe and per-user rate limiting.

**Tech Stack:** NestJS 11, Prisma (multi-file schema), BullMQ + Redis (ioredis), Socket.IO, Jest, Flutter + Riverpod + Freezed.

**Spec:** `docs/superpowers/specs/2026-08-01-notification-domain-producers-design.md`

## Global Constraints

- **Never run `git commit`.** The user stages and commits their own work. End each task by running the verification commands and stopping for review. This overrides the commit step in the writing-plans template.
- **`NotificationType` is append-only.** Never reorder or remove enum members — they are persisted in Postgres.
- **Producers never write notification tables and never push directly.** Use `NotificationService.create()` for the durable row and `NotificationService.notify()` for push. Calling `DEVICE_SERVICE.pushToUser` from a producer bypasses user preferences.
- **Strict TypeScript.** No `any`. No non-null assertions on event payloads.
- **Zero lint errors, zero Flutter analyzer warnings, zero regressions.**
- Backend commands run from `/Users/nasinaudaysankar/Downloads/soulzaa-backend`; Flutter from `/Users/nasinaudaysankar/Downloads/soulzaa-mobile`.
- Prisma schema is **multi-file** under `prisma/schema/`. Edit `notification.prisma`, not a single monolithic file.

## File Structure

**Backend — create:**

| File | Responsibility |
|---|---|
| `src/modules/notification/services/notification-guard.service.ts` | Redis dedupe (`once`) + per-user token bucket (`withinBudget`) |
| `src/modules/notification/services/notification-guard.service.spec.ts` | Guard tests |
| `src/modules/notification/listeners/wallet-notification.listener.ts` | `WALLET_EVENTS.CREDITED/DEBITED` → wallet notifications, allowlisted by `reason` |
| `src/modules/notification/listeners/game-notification.listener.ts` | `GAME_EVENTS.MATCH_FOUND/STARTED/SETTLED/FORFEITED` |
| `src/modules/notification/listeners/vip-notification.listener.ts` | `VIP_EVENTS.CREATED/RENEWED/UPGRADED/EXPIRING/EXPIRED` |
| `src/modules/notification/listeners/family-notification.listener.ts` | `FAMILY_EVENTS.MEMBER_JOINED/MEMBER_LEFT/DELETED` |
| `src/modules/notification/listeners/security-notification.listener.ts` | `AUTH_EVENTS.USER_LOGGED_IN/USER_PASSWORD_CHANGED` |
| `src/modules/notification/constants/notification-guard.constants.ts` | TTLs and bucket sizes |
| `src/modules/withdrawals/events/withdrawal.events.ts` | Typed `WITHDRAWAL_EVENTS` + payload classes |
| `src/modules/vip/services/vip-expiry.scheduler.ts` | Registers the daily repeatable sweep |
| `src/modules/vip/services/vip-expiry.service.ts` | Finds expiring/expired subs, publishes events |
| Matching `.spec.ts` beside each listener | |

**Backend — modify:** `device/interfaces/push.constants.ts`, `notification/services/push.policy.ts`, `notification/interfaces/notification.interface.ts`, `notification/notification.module.ts`, `prisma/schema/notification.prisma`, `vip/events/vip.events.ts`, `vip/services/vip-subscription.service.ts`, `withdrawals/services/withdrawal-approval.service.ts`, `games/events/game.events.ts`, `games/services/games.service.ts:959`.

**Flutter — modify:** `core/services/firebase/push_channels.dart`, `features/notifications/domain/entities/notification_type.dart`, `notification_category.dart`, `presentation/screens/notification_settings_screen.dart`, `deep_links/deep_link_router.dart`, `presentation/widgets/notification_l10n.dart`.

---

### Task 1: Add the four push categories (server side)

The compiler is the safety net here: `CATEGORY_SWITCH` in `push.policy.ts` is typed `Record<PushCategory, ...>`, so adding a category without deciding how a user disables it **fails to compile**. That is intentional — do not weaken the type to get past it.

**Files:**
- Modify: `src/modules/device/interfaces/push.constants.ts`
- Modify: `src/modules/notification/services/push.policy.ts:16-26`
- Modify: `src/modules/notification/interfaces/notification.interface.ts:40-60`
- Modify: `prisma/schema/notification.prisma:83-131`
- Test: `src/modules/device/services/push/push-channels.parity.spec.ts` (create)

**Interfaces:**
- Produces: `PUSH_CATEGORIES.WALLET | GAME | VIP | FAMILY`; `NotificationPreferenceView` gains `walletEvents`, `gameEvents`, `vipEvents`, `familyEvents` (all `boolean`); channel id prefixes `soulzaa_wallet`, `soulzaa_games`, `soulzaa_vip`, `soulzaa_family`.

- [ ] **Step 1: Write the failing parity test**

Create `src/modules/device/services/push/push-channels.parity.spec.ts`:

```ts
import { ALL_PUSH_CHANNEL_IDS, PUSH_CATEGORIES } from '../../interfaces/push.constants';

/**
 * The Flutter client hand-registers every channel the server can name
 * (push_channels.dart). Android silently DROPS a push naming a channel the app
 * never created, so drift between these two lists is invisible in production —
 * no error, no log, just notifications that never appear.
 *
 * This literal is the contract. Changing it means changing push_channels.dart in
 * soulzaa-mobile in the same change, or pushes vanish.
 */
const EXPECTED_CHANNEL_IDS = [
  'soulzaa_calls',
  'soulzaa_default',
  ...['soulzaa_messages', 'soulzaa_social', 'soulzaa_wallet', 'soulzaa_games', 'soulzaa_vip', 'soulzaa_family'].flatMap(
    (prefix) => ['sv', 'sn', 'nv', 'nn'].map((tone) => `${prefix}_${tone}`),
  ),
];

describe('push channel contract', () => {
  it('server channel ids exactly match the set the Flutter client registers', () => {
    expect([...ALL_PUSH_CHANNEL_IDS].sort()).toEqual([...EXPECTED_CHANNEL_IDS].sort());
  });

  it('exposes the four new domain categories', () => {
    expect(PUSH_CATEGORIES.WALLET).toBe('WALLET');
    expect(PUSH_CATEGORIES.GAME).toBe('GAME');
    expect(PUSH_CATEGORIES.VIP).toBe('VIP');
    expect(PUSH_CATEGORIES.FAMILY).toBe('FAMILY');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx jest src/modules/device/services/push/push-channels.parity.spec.ts`
Expected: FAIL — `PUSH_CATEGORIES.WALLET` is undefined and the id sets differ.

- [ ] **Step 3: Add the categories and channel prefixes**

In `src/modules/device/interfaces/push.constants.ts`, add to `PUSH_CATEGORIES` after `SYSTEM`:

```ts
  /** Coins in or out: recharge, refund, admin adjustment. */
  WALLET: 'WALLET',
  /** Match found, game started, win/loss, opponent left. */
  GAME: 'GAME',
  /** VIP activated, renewed, expiring, expired. */
  VIP: 'VIP',
  /** Family membership changes. Invitations ride INVITE. */
  FAMILY: 'FAMILY',
```

And add to `TUNABLE_CHANNEL_PREFIX`:

```ts
  [PUSH_CATEGORIES.WALLET]: 'soulzaa_wallet',
  [PUSH_CATEGORIES.GAME]: 'soulzaa_games',
  [PUSH_CATEGORIES.VIP]: 'soulzaa_vip',
  [PUSH_CATEGORIES.FAMILY]: 'soulzaa_family',
```

`ALL_PUSH_CHANNEL_IDS` is derived from that map, so it updates automatically.

- [ ] **Step 4: Add the preference switches**

In `src/modules/notification/services/push.policy.ts`, add to `CATEGORY_SWITCH`:

```ts
  [PUSH_CATEGORIES.WALLET]: 'walletEvents',
  [PUSH_CATEGORIES.GAME]: 'gameEvents',
  [PUSH_CATEGORIES.VIP]: 'vipEvents',
  [PUSH_CATEGORIES.FAMILY]: 'familyEvents',
```

In `src/modules/notification/interfaces/notification.interface.ts`, add to `NotificationPreferenceView` after `announcementEvents`:

```ts
  // ---- Domain producer categories ----
  walletEvents: boolean;
  gameEvents: boolean;
  vipEvents: boolean;
  familyEvents: boolean;
```

- [ ] **Step 5: Add the Prisma columns**

In `prisma/schema/notification.prisma`, inside `model NotificationPreference` after `announcementEvents`:

```prisma
  // ---- Domain producer categories (additive, default on) ----
  walletEvents Boolean @default(true)
  gameEvents   Boolean @default(true)
  vipEvents    Boolean @default(true)
  familyEvents Boolean @default(true)
```

- [ ] **Step 6: Fix every resulting compile error**

Run: `npx tsc --noEmit`

`DEFAULT_PREFERENCES` in `notification.service.ts` and any preference DTO / mapper will now fail to compile because the four keys are missing. Add all four as `true` everywhere the compiler points. Do not silence with casts.

- [ ] **Step 7: Generate the migration**

Run: `npx prisma migrate dev --name add_domain_notification_preferences`
Expected: a migration adding four `BOOLEAN NOT NULL DEFAULT true` columns. Confirm it contains no `DROP`.

- [ ] **Step 8: Verify**

Run: `npx jest src/modules/device src/modules/notification && npx tsc --noEmit && npx eslint src --max-warnings=0`
Expected: all pass. Stop for review.

---

### Task 2: Mirror the categories in Flutter

**Files:**
- Modify: `soulzaa-mobile/lib/core/services/firebase/push_channels.dart`
- Test: `soulzaa-mobile/test/core/push_channels_parity_test.dart` (create)

**Interfaces:**
- Consumes: the channel-id contract from Task 1.
- Produces: `PushCategory.wallet | game | vip | family` in Dart.

- [ ] **Step 1: Write the failing parity test**

Create `soulzaa-mobile/test/core/push_channels_parity_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:soulzaa/core/services/firebase/push_channels.dart';

/// Mirrors EXPECTED_CHANNEL_IDS in the backend's push-channels.parity.spec.ts.
/// Both sides assert against this same literal set; if either drifts, one fails.
const List<String> expectedChannelIds = <String>[
  'soulzaa_calls',
  'soulzaa_default',
  'soulzaa_messages_sv', 'soulzaa_messages_sn', 'soulzaa_messages_nv', 'soulzaa_messages_nn',
  'soulzaa_social_sv', 'soulzaa_social_sn', 'soulzaa_social_nv', 'soulzaa_social_nn',
  'soulzaa_wallet_sv', 'soulzaa_wallet_sn', 'soulzaa_wallet_nv', 'soulzaa_wallet_nn',
  'soulzaa_games_sv', 'soulzaa_games_sn', 'soulzaa_games_nv', 'soulzaa_games_nn',
  'soulzaa_vip_sv', 'soulzaa_vip_sn', 'soulzaa_vip_nv', 'soulzaa_vip_nn',
  'soulzaa_family_sv', 'soulzaa_family_sn', 'soulzaa_family_nv', 'soulzaa_family_nn',
];

void main() {
  test('registers exactly the channel ids the server can select', () {
    final Set<String> registered = PushChannels.all.map((PushChannel c) => c.id).toSet();
    expect(registered, expectedChannelIds.toSet());
  });

  test('maps every new category to a registered channel', () {
    for (final PushCategory c in <PushCategory>[
      PushCategory.wallet, PushCategory.game, PushCategory.vip, PushCategory.family,
    ]) {
      final String id = PushChannels.forCategory(c, sound: true, vibration: true);
      expect(expectedChannelIds, contains(id));
    }
  });

  test('unknown api strings still fall back to system', () {
    expect(PushCategory.fromApi('NOT_A_REAL_CATEGORY'), PushCategory.system);
  });
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `flutter test test/core/push_channels_parity_test.dart`
Expected: FAIL — `PushCategory.wallet` does not exist.

- [ ] **Step 3: Add the enum values**

In `push_channels.dart`, add to `enum PushCategory` before `security`:

```dart
  wallet('WALLET'),
  game('GAME'),
  vip('VIP'),
  family('FAMILY'),
```

- [ ] **Step 4: Add the prefixes and mapping**

Add the prefix constants beside `_socialPrefix`:

```dart
  static const String _walletPrefix = 'soulzaa_wallet';
  static const String _gamesPrefix = 'soulzaa_games';
  static const String _vipPrefix = 'soulzaa_vip';
  static const String _familyPrefix = 'soulzaa_family';
```

Add these cases to `forCategory`'s switch, before the `system`/`security` case:

```dart
      case PushCategory.wallet:
        return '${_walletPrefix}_${_tone(sound, vibration)}';
      case PushCategory.game:
        return '${_gamesPrefix}_${_tone(sound, vibration)}';
      case PushCategory.vip:
        return '${_vipPrefix}_${_tone(sound, vibration)}';
      case PushCategory.family:
        return '${_familyPrefix}_${_tone(sound, vibration)}';
```

The switch is exhaustive over the enum, so Dart's analyzer flags any category you forget.

- [ ] **Step 5: Register the channels at boot**

In `PushChannels.all`, inside the existing nested tone loop, add alongside the messages/social entries:

```dart
        PushChannel(
          id: '${_walletPrefix}_${_tone(sound, vibration)}',
          category: PushCategory.wallet,
          sound: sound,
          vibration: vibration,
          maxImportance: false,
        ),
        PushChannel(
          id: '${_gamesPrefix}_${_tone(sound, vibration)}',
          category: PushCategory.game,
          sound: sound,
          vibration: vibration,
          maxImportance: false,
        ),
        PushChannel(
          id: '${_vipPrefix}_${_tone(sound, vibration)}',
          category: PushCategory.vip,
          sound: sound,
          vibration: vibration,
          maxImportance: false,
        ),
        PushChannel(
          id: '${_familyPrefix}_${_tone(sound, vibration)}',
          category: PushCategory.family,
          sound: sound,
          vibration: vibration,
          maxImportance: false,
        ),
```

- [ ] **Step 6: Verify**

Run: `flutter test test/core/push_channels_parity_test.dart && flutter analyze`
Expected: PASS, zero analyzer issues. Stop for review.

---

### Task 3: `NotificationGuard` — dedupe and rate limiting

**Files:**
- Create: `src/modules/notification/constants/notification-guard.constants.ts`
- Create: `src/modules/notification/services/notification-guard.service.ts`
- Test: `src/modules/notification/services/notification-guard.service.spec.ts`

**Interfaces:**
- Consumes: `RedisService` from `src/infra/redis/redis.service.ts`, which exposes `public readonly client: RedisClient` (ioredis).
- Produces:
  - `NotificationGuard.once<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null>` — runs `fn` and returns its value on first call; returns `null` if `key` was already claimed within the TTL.
  - `NotificationGuard.withinBudget(userId: string, category: PushCategory): Promise<boolean>`
  - `GUARD_TTL.WALLET_TXN`, `GUARD_TTL.GAME_SESSION`, `GUARD_TTL.VIP_WINDOW`, `GUARD_TTL.LOGIN`
  - `GUARD_BUDGET.PER_CATEGORY_PER_HOUR`

- [ ] **Step 1: Write the failing tests**

Create `src/modules/notification/services/notification-guard.service.spec.ts`:

```ts
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import type { RedisService } from 'src/infra/redis/redis.service';
import { GUARD_BUDGET } from '../constants/notification-guard.constants';
import { NotificationGuard } from './notification-guard.service';

describe('NotificationGuard', () => {
  let client: { set: jest.Mock; incr: jest.Mock; expire: jest.Mock };
  let guard: NotificationGuard;

  beforeEach(() => {
    client = { set: jest.fn(), incr: jest.fn(), expire: jest.fn() };
    guard = new NotificationGuard({ client } as unknown as RedisService);
  });

  describe('once', () => {
    it('runs the work and returns its value when the key is unclaimed', async () => {
      client.set.mockResolvedValue('OK');
      const work = jest.fn().mockResolvedValue('done');

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBe('done');
      expect(work).toHaveBeenCalledTimes(1);
      expect(client.set).toHaveBeenCalledWith('notif:guard:wallet:txn-1', '1', 'EX', 3600, 'NX');
    });

    // The whole point: a duplicate event must not produce a second row or a second push.
    it('skips the work and returns null when the key is already claimed', async () => {
      client.set.mockResolvedValue(null);
      const work = jest.fn();

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBeNull();
      expect(work).not.toHaveBeenCalled();
    });

    // Redis being down must not silence notifications — failing open is the
    // recoverable mistake; failing closed loses a user's money notification.
    it('runs the work anyway when Redis errors', async () => {
      client.set.mockRejectedValue(new Error('ECONNREFUSED'));
      const work = jest.fn().mockResolvedValue('done');

      await expect(guard.once('wallet:txn-1', 3600, work)).resolves.toBe('done');
      expect(work).toHaveBeenCalledTimes(1);
    });
  });

  describe('withinBudget', () => {
    it('permits while under the hourly cap', async () => {
      client.incr.mockResolvedValue(1);
      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(true);
      expect(client.expire).toHaveBeenCalled();
    });

    it('refuses once the cap is exceeded', async () => {
      client.incr.mockResolvedValue(GUARD_BUDGET.PER_CATEGORY_PER_HOUR + 1);
      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(false);
    });

    it('sets the window TTL only on the first increment', async () => {
      client.incr.mockResolvedValue(5);
      await guard.withinBudget('u1', PUSH_CATEGORIES.WALLET);
      expect(client.expire).not.toHaveBeenCalled();
    });

    it('permits when Redis errors', async () => {
      client.incr.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(guard.withinBudget('u1', PUSH_CATEGORIES.WALLET)).resolves.toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx jest src/modules/notification/services/notification-guard.service.spec.ts`
Expected: FAIL — module `./notification-guard.service` not found.

- [ ] **Step 3: Write the constants**

Create `src/modules/notification/constants/notification-guard.constants.ts`:

```ts
/** How long a dedupe claim survives, per producer. */
export const GUARD_TTL = {
  /** A wallet transaction id is unique forever; an hour covers any retry storm. */
  WALLET_TXN: 3600,
  /** A game session settles once. */
  GAME_SESSION: 3600,
  /** A day, so the expiry sweep cannot ping the same user twice in one window. */
  VIP_WINDOW: 86_400,
  /** Token refresh can re-emit a login; five minutes absorbs it. */
  LOGIN: 300,
} as const;

export const GUARD_BUDGET = {
  /** Per user, per category, per hour. A runaway producer cannot flood one inbox. */
  PER_CATEGORY_PER_HOUR: 30,
  WINDOW_SECONDS: 3600,
} as const;
```

- [ ] **Step 4: Write the guard**

Create `src/modules/notification/services/notification-guard.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from 'src/infra/redis/redis.service';
import type { PushCategory } from 'src/modules/device/interfaces/push.constants';
import { GUARD_BUDGET } from '../constants/notification-guard.constants';

const PREFIX = 'notif:guard:';
const BUDGET_PREFIX = 'notif:budget:';

/**
 * Duplicate-suppression and per-user rate limiting for notification producers.
 *
 * Deliberately **opt-in at the call site** rather than inside
 * `NotificationService.create()`: two gifts in a row are two real events, and a
 * `create()` that silently no-opped would be a bug rather than a feature. A
 * producer that knows its natural idempotency key opts in; one that does not,
 * does not.
 *
 * Every method **fails open**. If Redis is unreachable we would rather send a
 * duplicate notification than drop a real one — a user seeing "recharge
 * successful" twice is an annoyance, a user never seeing it is a support ticket
 * about missing money.
 */
@Injectable()
export class NotificationGuard {
  private readonly logger = new Logger(NotificationGuard.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Run `fn` at most once per `key` per `ttlSeconds`.
   *
   * @returns `fn`'s value on the first call, or `null` when suppressed. Callers
   * that need to know whether they were the first can compare against null.
   */
  async once<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | null> {
    let claimed = true;
    try {
      const res = await this.redis.client.set(`${PREFIX}${key}`, '1', 'EX', ttlSeconds, 'NX');
      claimed = res === 'OK';
    } catch (err) {
      this.logger.warn(`dedupe check failed for "${key}", proceeding: ${(err as Error).message}`);
    }
    if (!claimed) return null;
    return fn();
  }

  /** Whether this user may receive another notification in this category this hour. */
  async withinBudget(userId: string, category: PushCategory): Promise<boolean> {
    const key = `${BUDGET_PREFIX}${userId}:${category}`;
    try {
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, GUARD_BUDGET.WINDOW_SECONDS);
      if (count > GUARD_BUDGET.PER_CATEGORY_PER_HOUR) {
        this.logger.warn(`rate limit hit: user=${userId} category=${category} count=${count}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(`budget check failed for ${userId}, permitting: ${(err as Error).message}`);
      return true;
    }
  }
}
```

- [ ] **Step 5: Register it**

In `src/modules/notification/notification.module.ts`, import `NotificationGuard`, add it to `providers` beside `PushPolicy`, and add `RedisModule` to `imports` if the guard cannot resolve `RedisService` (check whether `RedisModule` is `@Global` first — if it is, no import is needed).

- [ ] **Step 6: Verify**

Run: `npx jest src/modules/notification/services/notification-guard.service.spec.ts && npx tsc --noEmit`
Expected: 7 passing. Stop for review.

---

### Task 4: Add the twenty `NotificationType` values

**Files:**
- Modify: `prisma/schema/notification.prisma:9-52`

**Interfaces:**
- Produces: the enum members every later task references.

- [ ] **Step 1: Append to the enum**

In `prisma/schema/notification.prisma`, append to `enum NotificationType` (never reorder existing members):

```prisma
  // ---- Wallet (append-only) ----
  RECHARGE_SUCCESS
  WITHDRAWAL_APPROVED
  WITHDRAWAL_REJECTED
  REFUND_PROCESSED
  COINS_RECEIVED
  COINS_DEDUCTED

  // ---- Games ----
  GAME_MATCH_FOUND
  GAME_STARTED
  GAME_WON
  GAME_LOST
  GAME_OPPONENT_LEFT

  // ---- VIP ----
  VIP_ACTIVATED
  VIP_RENEWED
  VIP_EXPIRING
  VIP_EXPIRED

  // ---- Family (invitations ride the existing FAMILY_INVITE) ----
  FAMILY_MEMBER_JOINED
  FAMILY_MEMBER_LEFT
  FAMILY_REMOVED

  // ---- Security (never preference-gated) ----
  SECURITY_NEW_LOGIN
  SECURITY_PASSWORD_CHANGED
```

- [ ] **Step 2: Migrate and regenerate**

Run: `npx prisma migrate dev --name add_domain_notification_types`
Expected: migration contains only `ALTER TYPE ... ADD VALUE`. Confirm no value is dropped or renamed.

- [ ] **Step 3: Verify**

Run: `npx prisma generate && npx tsc --noEmit`
Expected: `NotificationType.RECHARGE_SUCCESS` etc. resolve. Stop for review.

---

### Task 5: Wallet listener

The single most important behaviour in this task is a **negative**: `GIFT_RECEIVE` must produce nothing, because `gift-notification.listener.ts` already notifies the receiver. Without that exclusion every gift on the platform notifies twice.

**Files:**
- Create: `src/modules/notification/listeners/wallet-notification.listener.ts`
- Test: `src/modules/notification/listeners/wallet-notification.listener.spec.ts`

**Interfaces:**
- Consumes: `WALLET_EVENTS.CREDITED/DEBITED`, payload `{ userId, transactionId, currency, amount, balanceAfter, reason: WalletTxnReason, referenceType, referenceId }`; `NotificationGuard.once`; `GUARD_TTL.WALLET_TXN`.

- [ ] **Step 1: Write the failing tests**

Create `src/modules/notification/listeners/wallet-notification.listener.spec.ts`:

```ts
import { NotificationType, WalletTxnReason } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { WALLET_EVENTS } from 'src/modules/wallet/events/wallet.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { WalletNotificationListener } from './wallet-notification.listener';

const USER = 'user-1';

const payload = (overrides: Record<string, unknown> = {}) => ({
  userId: USER,
  transactionId: 'txn-1',
  currency: 'COIN',
  amount: 500,
  balanceAfter: 1500,
  reason: WalletTxnReason.RECHARGE,
  referenceType: null,
  referenceId: null,
  ...overrides,
});

describe('WalletNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let credited: (e: { payload: ReturnType<typeof payload> }) => Promise<void>;
  let debited: (e: { payload: ReturnType<typeof payload> }) => Promise<void>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    // Pass-through guard: dedupe is covered by its own spec.
    guard = { once: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) => fn()) };

    const listener = new WalletNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();

    const byEvent = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]]));
    credited = byEvent.get(WALLET_EVENTS.CREDITED);
    debited = byEvent.get(WALLET_EVENTS.DEBITED);
  });

  it('notifies on a successful recharge', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.RECHARGE }) });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        type: NotificationType.RECHARGE_SUCCESS,
        entityType: 'wallet_transaction',
        entityId: 'txn-1',
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(USER, expect.anything());
  });

  it.each([
    WalletTxnReason.GIFT_REFUND,
    WalletTxnReason.GAME_REFUND,
    WalletTxnReason.LUCKY_PACKET_REFUND,
    WalletTxnReason.CASINO_REFUND,
  ])('notifies REFUND_PROCESSED for %s', async (reason) => {
    await credited({ payload: payload({ reason }) });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.REFUND_PROCESSED }),
    );
  });

  it('notifies COINS_RECEIVED on an admin credit', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.ADMIN_CREDIT }) });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.COINS_RECEIVED }),
    );
  });

  it('notifies COINS_DEDUCTED on an admin debit', async () => {
    await debited({ payload: payload({ reason: WalletTxnReason.ADMIN_DEBIT }) });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.COINS_DEDUCTED }),
    );
  });

  // THE regression guard. gift-notification.listener.ts already notifies the
  // receiver on GIFT_EVENTS.SENT. If the wallet listener also fires on the
  // GIFT_RECEIVE movement, every gift notifies twice.
  it('stays silent on GIFT_RECEIVE — the gift listener already covers it', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.GIFT_RECEIVE }) });
    expect(notifications.create).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  // Same reasoning: GAME_WON already fires from the games listener.
  it('stays silent on GAME_PAYOUT', async () => {
    await credited({ payload: payload({ reason: WalletTxnReason.GAME_PAYOUT }) });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it.each([
    WalletTxnReason.CASINO_BET,
    WalletTxnReason.GAME_STAKE,
    WalletTxnReason.RESERVATION_HOLD,
    WalletTxnReason.COSMETIC_PURCHASE,
  ])('stays silent on routine movement %s', async (reason) => {
    await debited({ payload: payload({ reason }) });
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('dedupes on the transaction id', async () => {
    await credited({ payload: payload() });
    expect(guard.once).toHaveBeenCalledWith('wallet:txn-1', expect.any(Number), expect.any(Function));
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx jest src/modules/notification/listeners/wallet-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the listener**

Create `src/modules/notification/listeners/wallet-notification.listener.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType, WalletTxnReason } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  WALLET_EVENTS,
  type WalletCreditedEvent,
  type WalletDebitedEvent,
  type WalletMovementPayload,
} from 'src/modules/wallet/events/wallet.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/** Copy for one notifiable movement. */
interface WalletNotice {
  type: NotificationType;
  title: string;
  body: (amount: number) => string;
}

/**
 * The allowlist. `WalletTxnReason` has 34 members and the wallet emits on every
 * one of them — including `CASINO_BET` and `RESERVATION_HOLD`, which fire
 * constantly during normal play. Deny by default and enumerate only what a user
 * actually wants to hear about.
 *
 * Two deliberate absences:
 *  - `GIFT_RECEIVE` / `GIFT_SEND` — `GiftNotificationListener` already notifies
 *    the receiver on `GIFT_EVENTS.SENT`. Adding them here double-notifies every
 *    gift on the platform.
 *  - `GAME_PAYOUT` — `GameNotificationListener` already sends `GAME_WON`.
 */
const NOTIFIABLE: Partial<Record<WalletTxnReason, WalletNotice>> = {
  [WalletTxnReason.RECHARGE]: {
    type: NotificationType.RECHARGE_SUCCESS,
    title: 'Recharge successful',
    body: (a) => `${a} coins added to your wallet`,
  },
  [WalletTxnReason.GIFT_REFUND]: {
    type: NotificationType.REFUND_PROCESSED,
    title: 'Refund processed',
    body: (a) => `${a} coins refunded to your wallet`,
  },
  [WalletTxnReason.GAME_REFUND]: {
    type: NotificationType.REFUND_PROCESSED,
    title: 'Refund processed',
    body: (a) => `${a} coins refunded to your wallet`,
  },
  [WalletTxnReason.LUCKY_PACKET_REFUND]: {
    type: NotificationType.REFUND_PROCESSED,
    title: 'Refund processed',
    body: (a) => `${a} coins refunded to your wallet`,
  },
  [WalletTxnReason.CASINO_REFUND]: {
    type: NotificationType.REFUND_PROCESSED,
    title: 'Refund processed',
    body: (a) => `${a} coins refunded to your wallet`,
  },
  [WalletTxnReason.ADMIN_CREDIT]: {
    type: NotificationType.COINS_RECEIVED,
    title: 'Coins received',
    body: (a) => `${a} coins were added to your wallet`,
  },
  [WalletTxnReason.ADMIN_DEBIT]: {
    type: NotificationType.COINS_DEDUCTED,
    title: 'Coins deducted',
    body: (a) => `${a} coins were removed from your wallet`,
  },
  [WalletTxnReason.EVENT_REWARD]: {
    type: NotificationType.COINS_RECEIVED,
    title: 'Reward received',
    body: (a) => `You earned ${a} coins`,
  },
  [WalletTxnReason.ATTENDANCE_REWARD]: {
    type: NotificationType.COINS_RECEIVED,
    title: 'Daily reward',
    body: (a) => `You earned ${a} coins`,
  },
  [WalletTxnReason.SPIN_WHEEL_REWARD]: {
    type: NotificationType.COINS_RECEIVED,
    title: 'Reward received',
    body: (a) => `You won ${a} coins`,
  },
};

/**
 * Turns notable wallet movements into notifications.
 *
 * Because `reason` fully discriminates the cases, the wallet module needs no new
 * events — this listener reads the two it already publishes.
 */
@Injectable()
export class WalletNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<WalletCreditedEvent>(WALLET_EVENTS.CREDITED, (e) => this.onMovement(e));
    this.bus.subscribe<WalletDebitedEvent>(WALLET_EVENTS.DEBITED, (e) => this.onMovement(e));
  }

  private async onMovement(e: { payload: WalletMovementPayload }): Promise<void> {
    const { userId, transactionId, amount, balanceAfter, reason } = e.payload;

    const notice = NOTIFIABLE[reason];
    if (!notice) return;

    await this.guard.once(`wallet:${transactionId}`, GUARD_TTL.WALLET_TXN, async () => {
      await this.notifications.create({
        userId,
        type: notice.type,
        entityType: 'wallet_transaction',
        entityId: transactionId,
        data: { amount, balanceAfter, reason },
      });

      await this.notifications.notify(userId, {
        category: PUSH_CATEGORIES.WALLET,
        title: notice.title,
        body: notice.body(amount),
        // A balance is private; a lock screen does not need to advertise it.
        redactedBody: 'Your wallet was updated',
        threadId: `wallet_${userId}`,
        badge: 'unread',
        data: { type: 'wallet', transactionId, reason },
      });
    });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx jest src/modules/notification/listeners/wallet-notification.listener.spec.ts`
Expected: all pass, including the `GIFT_RECEIVE` and `GAME_PAYOUT` silence tests.

- [ ] **Step 5: Register the listener**

Add `WalletNotificationListener` to the `providers` array in `notification.module.ts` under the `// listeners` comment.

- [ ] **Step 6: Verify**

Run: `npx jest src/modules/notification && npx tsc --noEmit && npx eslint src --max-warnings=0`
Expected: green. Stop for review.

---

### Task 6: Games listener

`GameSettledEvent` carries `winners: string[]` and `payouts`, but **not the full participant list** — so losers cannot be derived from it today. This task adds `participants: string[]` to that payload (a small additive change at the single publish site) so `GAME_LOST` is possible. If review rejects that change, drop `GAME_LOST` and notify winners only.

**Files:**
- Modify: `src/modules/games/events/game.events.ts:103-115`
- Modify: `src/modules/games/services/games.service.ts:959`
- Create: `src/modules/notification/listeners/game-notification.listener.ts`
- Test: `src/modules/notification/listeners/game-notification.listener.spec.ts`

**Interfaces:**
- Consumes: `GAME_EVENTS.MATCH_FOUND` (`{ matchId, gameCode, stake, matchType, players, readySeconds, expiresAt }`), `GAME_EVENTS.SETTLED` (`{ sessionId, gameCode, winners, payouts, participants }` after this task).
- Produces: `GameSettledEvent` payload gains `participants: string[]`.

- [ ] **Step 1: Add `participants` to the settled payload**

In `src/modules/games/events/game.events.ts`, add to `GameSettledEvent`'s payload type:

```ts
  /** Everyone who played, winners included. Needed to notify losers. */
  participants: string[];
```

In `src/modules/games/services/games.service.ts:959`, populate it from the session's participant list at that call site (the same source `GameStartedEvent.participants` uses).

- [ ] **Step 2: Write the failing tests**

Create `src/modules/notification/listeners/game-notification.listener.spec.ts`:

```ts
import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { GAME_EVENTS } from 'src/modules/games/events/game.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { GameNotificationListener } from './game-notification.listener';

const WINNER = 'winner-1';
const LOSER = 'loser-1';

describe('GameNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let handlers: Map<string, (e: { payload: Record<string, unknown> }) => Promise<void>>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = { once: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) => fn()) };

    const listener = new GameNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();
    handlers = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]]));
  });

  it('tells the winner they won and the loser they lost', async () => {
    await handlers.get(GAME_EVENTS.SETTLED)!({
      payload: {
        sessionId: 'sess-1',
        gameCode: 'LUDO',
        winners: [WINNER],
        participants: [WINNER, LOSER],
        payouts: [{ userId: WINNER, amount: 200 }],
      },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: WINNER, type: NotificationType.GAME_WON }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: LOSER, type: NotificationType.GAME_LOST }),
    );
    expect(notifications.create).toHaveBeenCalledTimes(2);
  });

  it('notifies every matched player when a match is found', async () => {
    await handlers.get(GAME_EVENTS.MATCH_FOUND)!({
      payload: { matchId: 'm-1', gameCode: 'LUDO', stake: 100, players: [WINNER, LOSER] },
    });

    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.GAME_MATCH_FOUND }),
    );
  });

  it('dedupes settlement per session and per user', async () => {
    await handlers.get(GAME_EVENTS.SETTLED)!({
      payload: {
        sessionId: 'sess-1',
        gameCode: 'LUDO',
        winners: [WINNER],
        participants: [WINNER],
        payouts: [],
      },
    });
    expect(guard.once).toHaveBeenCalledWith(
      `game:sess-1:${WINNER}`,
      expect.any(Number),
      expect.any(Function),
    );
  });

  // In-session churn is socket traffic; the player is already looking at the screen.
  it('does not subscribe to lobby churn or turn events', () => {
    const subscribed = [...handlers.keys()];
    expect(subscribed).not.toContain(GAME_EVENTS.LOBBY_JOINED);
    expect(subscribed).not.toContain(GAME_EVENTS.LOBBY_MEMBER_READY);
    expect(subscribed).not.toContain(GAME_EVENTS.MOVE);
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx jest src/modules/notification/listeners/game-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the listener**

Create `src/modules/notification/listeners/game-notification.listener.ts`:

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import {
  GAME_EVENTS,
  type GameMatchFoundEvent,
  type GameSettledEvent,
} from 'src/modules/games/events/game.events';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/**
 * Game outcomes worth interrupting someone for.
 *
 * Lobby churn (`LOBBY_JOINED`, `LOBBY_MEMBER_READY`, `TURN_*`, `MOVE`) is
 * deliberately not subscribed: those are in-session socket events and the player
 * is already looking at the board. A notification for each would be noise.
 */
@Injectable()
export class GameNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<GameMatchFoundEvent>(GAME_EVENTS.MATCH_FOUND, (e) => this.onMatchFound(e));
    this.bus.subscribe<GameSettledEvent>(GAME_EVENTS.SETTLED, (e) => this.onSettled(e));
  }

  private async onMatchFound(e: GameMatchFoundEvent): Promise<void> {
    const { matchId, gameCode, stake, players } = e.payload;

    await Promise.all(
      players.map((userId) =>
        this.guard.once(`game-match:${matchId}:${userId}`, GUARD_TTL.GAME_SESSION, async () => {
          await this.notifications.create({
            userId,
            type: NotificationType.GAME_MATCH_FOUND,
            entityType: 'game_match',
            entityId: matchId,
            data: { gameCode, stake },
          });
          await this.notifications.notify(userId, {
            category: PUSH_CATEGORIES.GAME,
            title: 'Match found',
            body: `Your ${gameCode} match is ready — tap to join`,
            threadId: `game_${userId}`,
            badge: 'unread',
            data: { type: 'game_match_found', matchId, gameCode },
          });
        }),
      ),
    );
  }

  private async onSettled(e: GameSettledEvent): Promise<void> {
    const { sessionId, gameCode, winners, participants, payouts } = e.payload;
    const won = new Set(winners);
    const payoutFor = new Map(payouts.map((p) => [p.userId, p.amount]));

    await Promise.all(
      participants.map((userId) =>
        this.guard.once(`game:${sessionId}:${userId}`, GUARD_TTL.GAME_SESSION, async () => {
          const isWinner = won.has(userId);
          const amount = payoutFor.get(userId) ?? 0;

          await this.notifications.create({
            userId,
            type: isWinner ? NotificationType.GAME_WON : NotificationType.GAME_LOST,
            entityType: 'game_session',
            entityId: sessionId,
            data: { gameCode, amount, won: isWinner },
          });

          await this.notifications.notify(userId, {
            category: PUSH_CATEGORIES.GAME,
            title: isWinner ? 'You won!' : 'Game over',
            body: isWinner ? `You won ${amount} coins in ${gameCode}` : `Better luck next time in ${gameCode}`,
            threadId: `game_${userId}`,
            badge: 'unread',
            data: { type: 'game_settled', sessionId, gameCode },
          });
        }),
      ),
    );
  }
}
```

- [ ] **Step 5: Register and verify**

Add `GameNotificationListener` to `notification.module.ts` providers.

Run: `npx jest src/modules/notification src/modules/games && npx tsc --noEmit`
Expected: green, and the existing games suite unaffected by the `participants` addition. Stop for review.

---

### Task 7: VIP events, listener, and expiry sweep

`VipEventService` is currently called with untyped string literals (`'vip.created'`, `'vip.renewed'`, `'vip.upgraded'`) from `vip-subscription.service.ts` at four call sites, while `VIP_EVENTS` declares only `UPGRADED`. This task makes those declared and typed, then adds the expiry sweep that `VIP_EXPIRING` / `VIP_EXPIRED` need — nothing happens when time passes, so only a scheduled job can emit them.

**Files:**
- Modify: `src/modules/vip/events/vip.events.ts`
- Modify: `src/modules/vip/services/vip-subscription.service.ts:147,226,313,411`
- Create: `src/modules/vip/services/vip-expiry.service.ts`
- Create: `src/modules/vip/services/vip-expiry.scheduler.ts`
- Create: `src/modules/notification/listeners/vip-notification.listener.ts`
- Test: `src/modules/notification/listeners/vip-notification.listener.spec.ts`
- Test: `src/modules/vip/services/vip-expiry.service.spec.ts`

**Interfaces:**
- Produces: `VIP_EVENTS.CREATED = 'vip.created'`, `RENEWED = 'vip.renewed'`, `EXPIRING = 'vip.expiring'`, `EXPIRED = 'vip.expired'`; payloads `{ userId, level, expiresAt }` for created/renewed/expiring and `{ userId, level }` for expired.

- [ ] **Step 1: Declare the events**

In `src/modules/vip/events/vip.events.ts`, extend `VIP_EVENTS` and add payload classes:

```ts
export const VIP_EVENTS = {
  UPGRADED: 'vip.upgraded',
  /** Already emitted by VipSubscriptionService as a bare string — now declared. */
  CREATED: 'vip.created',
  RENEWED: 'vip.renewed',
  /** Emitted only by the expiry sweep; nothing happens when time passes. */
  EXPIRING: 'vip.expiring',
  EXPIRED: 'vip.expired',
} as const;

export class VipCreatedEvent extends DomainEvent<{
  userId: string;
  level: VipLevel;
  expiresAt: Date;
}> {
  readonly name = VIP_EVENTS.CREATED;
}

export class VipRenewedEvent extends DomainEvent<{
  userId: string;
  level: VipLevel;
  expiresAt: Date;
}> {
  readonly name = VIP_EVENTS.RENEWED;
}

export class VipExpiringEvent extends DomainEvent<{
  userId: string;
  level: VipLevel;
  expiresAt: Date;
  daysRemaining: number;
}> {
  readonly name = VIP_EVENTS.EXPIRING;
}

export class VipExpiredEvent extends DomainEvent<{
  userId: string;
  level: VipLevel;
}> {
  readonly name = VIP_EVENTS.EXPIRED;
}
```

Then replace the four bare string literals in `vip-subscription.service.ts` with `VIP_EVENTS.CREATED` / `VIP_EVENTS.RENEWED` / `VIP_EVENTS.UPGRADED`.

- [ ] **Step 2: Write the failing listener test**

Create `src/modules/notification/listeners/vip-notification.listener.spec.ts`:

```ts
import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { VIP_EVENTS } from 'src/modules/vip/events/vip.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { VipNotificationListener } from './vip-notification.listener';

const USER = 'user-1';

describe('VipNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let handlers: Map<string, (e: { payload: Record<string, unknown> }) => Promise<void>>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = { once: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) => fn()) };

    const listener = new VipNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();
    handlers = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]]));
  });

  it.each([
    [VIP_EVENTS.CREATED, NotificationType.VIP_ACTIVATED],
    [VIP_EVENTS.RENEWED, NotificationType.VIP_RENEWED],
    [VIP_EVENTS.EXPIRED, NotificationType.VIP_EXPIRED],
  ])('maps %s to %s', async (event, type) => {
    await handlers.get(event)!({ payload: { userId: USER, level: 'VIP1', expiresAt: new Date() } });
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, type }),
    );
  });

  it('dedupes the expiring warning per user per day', async () => {
    await handlers.get(VIP_EVENTS.EXPIRING)!({
      payload: { userId: USER, level: 'VIP1', expiresAt: new Date(), daysRemaining: 3 },
    });
    expect(guard.once).toHaveBeenCalledWith(
      expect.stringContaining(`vip-expiring:${USER}:`),
      expect.any(Number),
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx jest src/modules/notification/listeners/vip-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the listener**

Create `src/modules/notification/listeners/vip-notification.listener.ts` following the wallet listener's shape: subscribe to `CREATED`→`VIP_ACTIVATED`, `RENEWED`→`VIP_RENEWED`, `EXPIRING`→`VIP_EXPIRING`, `EXPIRED`→`VIP_EXPIRED`, all on `PUSH_CATEGORIES.VIP`. Use dedupe key `vip-expiring:${userId}:${expiresAt.toISOString().slice(0, 10)}` with `GUARD_TTL.VIP_WINDOW` for the expiring case and `vip:${userId}:${event}` for the rest. Bodies: "Your VIP is now active", "Your VIP has been renewed", "Your VIP expires in N days", "Your VIP has expired".

- [ ] **Step 5: Write the expiry sweep**

Create `src/modules/vip/services/vip-expiry.service.ts` with a `sweep()` method that queries active subscriptions where `expiresAt` falls within the next 3 days (emit `VipExpiringEvent` with `daysRemaining`) and those already past `expiresAt` but not yet marked expired (emit `VipExpiredEvent`, mark the row). Create `vip-expiry.scheduler.ts` modelled exactly on `src/modules/otp/services/otp.scheduler.ts`: register a repeatable job with a stable `jobId` so restarts do not accumulate schedules, `repeat: { pattern: '0 3 * * *' }`, on `QUEUE_NAMES.NOTIFICATIONS`, and register the handler through `QueueJobRegistry.register(QUEUE_NAMES.NOTIFICATIONS, 'vip.expiry-sweep', () => this.expiry.sweep())`.

Write `vip-expiry.service.spec.ts` covering: a subscription 3 days out emits `EXPIRING`; one 10 days out emits nothing; one past expiry emits `EXPIRED` and is marked; an already-marked expired row emits nothing on the second sweep.

- [ ] **Step 6: Register and verify**

Add `VipNotificationListener` to `notification.module.ts`; add `VipExpiryService` and `VipExpiryScheduler` to the VIP module's providers.

Run: `npx jest src/modules/vip src/modules/notification && npx tsc --noEmit`
Expected: green. Stop for review.

---

### Task 8: Withdrawal events and listener

`WithdrawalEventService.publishWithdrawalEvent(eventName: string, payload: any)` has **zero callers** and is typed `any`. Replace it with typed events published from the real approval path.

**Files:**
- Create: `src/modules/withdrawals/events/withdrawal.events.ts`
- Modify: `src/modules/withdrawals/events/index.ts`
- Modify: `src/modules/withdrawals/services/withdrawal-approval.service.ts`
- Modify: `src/modules/notification/listeners/wallet-notification.listener.ts` (add the two subscriptions)
- Test: extend `src/modules/notification/listeners/wallet-notification.listener.spec.ts`

**Interfaces:**
- Produces: `WITHDRAWAL_EVENTS.APPROVED = 'withdrawal.approved'`, `REJECTED = 'withdrawal.rejected'`; payload `{ withdrawalId: string; userId: string; amount: number; reason?: string }`.

- [ ] **Step 1: Write the typed events**

Create `src/modules/withdrawals/events/withdrawal.events.ts`:

```ts
import { DomainEvent } from 'src/common/events';

/**
 * Withdrawal lifecycle events. Replaces the untyped
 * `WithdrawalEventService.publishWithdrawalEvent(name: string, payload: any)`,
 * which had no callers.
 */
export const WITHDRAWAL_EVENTS = {
  APPROVED: 'withdrawal.approved',
  REJECTED: 'withdrawal.rejected',
} as const;

export interface WithdrawalDecisionPayload {
  withdrawalId: string;
  userId: string;
  amount: number;
  /** Present on rejection: why, so the user is not left guessing. */
  reason?: string;
}

export class WithdrawalApprovedEvent extends DomainEvent<WithdrawalDecisionPayload> {
  readonly name = WITHDRAWAL_EVENTS.APPROVED;
}

export class WithdrawalRejectedEvent extends DomainEvent<WithdrawalDecisionPayload> {
  readonly name = WITHDRAWAL_EVENTS.REJECTED;
}
```

Export both from `src/modules/withdrawals/events/index.ts`.

- [ ] **Step 2: Publish from the approval path**

In `withdrawal-approval.service.ts`, publish `WithdrawalApprovedEvent` / `WithdrawalRejectedEvent` on `EVENT_BUS` inside the approve and reject transitions, **after** the status write commits. Delete `withdrawal-event.service.ts` and its module registration if nothing else references it; if anything does, leave it and add a `@deprecated` note.

- [ ] **Step 3: Extend the wallet listener spec**

Add to `wallet-notification.listener.spec.ts`:

```ts
  it('notifies on withdrawal approval', async () => {
    const approved = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]])).get(
      WITHDRAWAL_EVENTS.APPROVED,
    )!;
    await approved({ payload: { withdrawalId: 'w-1', userId: USER, amount: 5000 } });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, type: NotificationType.WITHDRAWAL_APPROVED }),
    );
  });

  it('includes the reason when a withdrawal is rejected', async () => {
    const rejected = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]])).get(
      WITHDRAWAL_EVENTS.REJECTED,
    )!;
    await rejected({ payload: { withdrawalId: 'w-2', userId: USER, amount: 5000, reason: 'KYC incomplete' } });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: NotificationType.WITHDRAWAL_REJECTED,
        data: expect.objectContaining({ reason: 'KYC incomplete' }),
      }),
    );
  });
```

- [ ] **Step 4: Add the subscriptions**

In `wallet-notification.listener.ts`'s `onModuleInit`, subscribe to both withdrawal events and map them to `WITHDRAWAL_APPROVED` / `WITHDRAWAL_REJECTED` on `PUSH_CATEGORIES.WALLET`, deduped on `withdrawal:${withdrawalId}`.

- [ ] **Step 5: Verify**

Run: `npx jest src/modules/notification src/modules/withdrawals && npx tsc --noEmit`
Expected: green. Stop for review.

---

### Task 9: Family listener

**Verified leadership model:** `Family.founderId` is the owner (note the schema says `founderId` while `FamilyCreatedEvent`'s payload calls the same person `leaderId`). `FamilyMember.role` is a plain `String @default("MEMBER")` — **not an enum** — and the only values used in code are `'ELDER'` and `'MEMBER'`. There is no `ADMIN`. `@@index([familyId, role])` makes the officer query cheap.

"Officers" = founder + members with role `'ELDER'`.

**Files:**
- Create: `src/modules/notification/listeners/family-notification.listener.ts`
- Test: `src/modules/notification/listeners/family-notification.listener.spec.ts`

**Interfaces:**
- Consumes: `FAMILY_EVENTS.MEMBER_JOINED` (`{ familyId, userId }`), `MEMBER_LEFT` (`{ familyId, userId, kicked, actorId }`), `DELETED` (`{ familyId, leaderId }`); a family read service for officer/member lookup.

- [ ] **Step 1: Write the failing tests**

Cover: (a) `MEMBER_JOINED` creates rows only for officers, never for the whole family — assert with a 50-member family that `create` is called once per officer and not 50 times; (b) a kicked member receives `FAMILY_REMOVED`; (c) a voluntary leave notifies officers with `FAMILY_MEMBER_LEFT`; (d) the departing member is never notified about their own voluntary departure; (e) `DELETED` fans out to all members.

- [ ] **Step 2: Run and confirm failure**

Run: `npx jest src/modules/notification/listeners/family-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the listener**

Follow the wallet listener's shape, on `PUSH_CATEGORIES.FAMILY`. Resolve officers via the families repository (`founderId` + members where `role === 'ELDER'`). Guard each recipient with `family:${familyId}:${userId}:${event}`.

Document the fan-out cap in the class doc comment: notifying every member on every join is O(members) rows per join, so joins and leaves go to officers only; `DELETED` is the single full fan-out because it is rare and genuinely concerns everyone.

- [ ] **Step 4: Register and verify**

Add to `notification.module.ts` providers.

Run: `npx jest src/modules/notification src/modules/families && npx tsc --noEmit`
Expected: green. Stop for review.

---

### Task 10: Security listener

**This task was redesigned after reading the existing code.** The original plan — subscribe to `AUTH_EVENTS.USER_LOGGED_IN` and push an alert excluding the originating device — is wrong on three counts:

1. **The push already exists.** `device.service.ts:136-151` already builds and enqueues a `SECURITY` login alert with `excludeDeviceId: device.id` on `DEVICE_JOBS.LOGIN_ALERT`, gated by the `SUSPICIOUS_LOGIN_ALERTS` config flag. Pushing again from a notification listener would double-alert every suspicious login.
2. **`USER_LOGGED_IN` is the wrong signal.** It fires on *every* successful login, not just suspicious ones. The device module deliberately alerts only on `new_device` or `country_change`, and only when the account already has another active device (`device.service.ts:112-115`).
3. **`excludeDeviceId` is unreachable from here anyway.** `PushIntent` has no such field, so `NotificationService.notify()` cannot exclude a device — and `auth.service.ts:416` publishes `UserLoggedInEvent` with `deviceId: null` hardcoded regardless.

**What is actually missing** is the durable row. The existing alert is a fire-and-forget push: nothing writes a `Notification`, so a user who dismisses or misses it has no security history in the notification centre. This task fills that gap and does **not** re-push for logins.

**Files:**
- Create: `src/modules/notification/listeners/security-notification.listener.ts`
- Test: `src/modules/notification/listeners/security-notification.listener.spec.ts`

**Interfaces:**
- Consumes: `SuspiciousLoginDetectedEvent` from `src/modules/device/events/device.events.ts`, payload `{ userId, deviceId, reason: 'new_device' | 'country_change', ip: string | null, country: string | null }`; `AUTH_EVENTS.USER_PASSWORD_CHANGED`.

- [ ] **Step 1: Confirm the event's exact name and payload**

Run: `grep -n -A12 "SuspiciousLoginDetectedEvent" src/modules/device/events/device.events.ts`
Use the exact field names it prints in the test and listener below. Do not guess.

- [ ] **Step 2: Write the failing tests**

```ts
import { NotificationType } from '@prisma/client';
import type { IEventBus } from 'src/common/events';
import { DEVICE_EVENTS } from 'src/modules/device/events/device.events';
import { AUTH_EVENTS } from 'src/modules/auth/events/auth.events';
import type { NotificationGuard } from '../services/notification-guard.service';
import type { NotificationService } from '../services/notification.service';
import { SecurityNotificationListener } from './security-notification.listener';

const USER = 'user-1';

describe('SecurityNotificationListener', () => {
  let bus: { publish: jest.Mock; subscribe: jest.Mock };
  let notifications: { create: jest.Mock; notify: jest.Mock };
  let guard: { once: jest.Mock };
  let handlers: Map<string, (e: { payload: Record<string, unknown> }) => Promise<void>>;

  beforeEach(() => {
    bus = { publish: jest.fn(), subscribe: jest.fn() };
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };
    guard = { once: jest.fn((_k: string, _t: number, fn: () => Promise<unknown>) => fn()) };

    const listener = new SecurityNotificationListener(
      bus as unknown as IEventBus,
      notifications as unknown as NotificationService,
      guard as unknown as NotificationGuard,
    );
    listener.onModuleInit();
    handlers = new Map(bus.subscribe.mock.calls.map((c) => [c[0], c[1]]));
  });

  it('writes a durable row for a suspicious login', async () => {
    await handlers.get(DEVICE_EVENTS.SUSPICIOUS_LOGIN)!({
      payload: { userId: USER, deviceId: 'dev-1', reason: 'new_device', ip: '1.2.3.4', country: 'IN' },
    });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        type: NotificationType.SECURITY_NEW_LOGIN,
        entityType: 'device',
        entityId: 'dev-1',
      }),
    );
  });

  // device.service.ts:136-151 already enqueues the SECURITY push with
  // excludeDeviceId. Pushing again here would double-alert every suspicious login.
  it('does NOT push for a suspicious login — the device module already does', async () => {
    await handlers.get(DEVICE_EVENTS.SUSPICIOUS_LOGIN)!({
      payload: { userId: USER, deviceId: 'dev-1', reason: 'new_device', ip: null, country: null },
    });

    expect(notifications.notify).not.toHaveBeenCalled();
  });

  // Every login is not a security event. Only the device module's suspicious
  // determination is, and it already filters on new-device / country-change.
  it('does not subscribe to USER_LOGGED_IN', () => {
    expect([...handlers.keys()]).not.toContain(AUTH_EVENTS.USER_LOGGED_IN);
  });

  it('both writes and pushes on a password change — nothing else covers it', async () => {
    await handlers.get(AUTH_EVENTS.USER_PASSWORD_CHANGED)!({ payload: { userId: USER } });

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: NotificationType.SECURITY_PASSWORD_CHANGED }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ category: PUSH_CATEGORIES.SECURITY }),
    );
  });

  it('deduplicates repeated suspicious logins from the same device', async () => {
    await handlers.get(DEVICE_EVENTS.SUSPICIOUS_LOGIN)!({
      payload: { userId: USER, deviceId: 'dev-1', reason: 'new_device', ip: null, country: null },
    });
    expect(guard.once).toHaveBeenCalledWith(
      `login:${USER}:dev-1`,
      expect.any(Number),
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 3: Run and confirm failure**

Run: `npx jest src/modules/notification/listeners/security-notification.listener.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the listener**

```ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { AUTH_EVENTS, type UserPasswordChangedEvent } from 'src/modules/auth/events/auth.events';
import { DEVICE_EVENTS, type SuspiciousLoginDetectedEvent } from 'src/modules/device/events/device.events';
import { PUSH_CATEGORIES } from 'src/modules/device/interfaces/push.constants';
import { GUARD_TTL } from '../constants/notification-guard.constants';
import { NotificationGuard } from '../services/notification-guard.service';
import { NotificationService } from '../services/notification.service';

/**
 * Durable security history.
 *
 * This listener deliberately does **not** push for logins. `DeviceService`
 * already enqueues the `SECURITY` login alert with `excludeDeviceId` (see
 * device.service.ts) and does it *outside* `PushPolicy`, because an alert the
 * intruder could silence from inside the account is not an alert. Re-pushing here
 * would double-alert.
 *
 * What was missing is the row. That push is fire-and-forget, so a user who missed
 * it had no way to find out later that a new device signed in. `create()` without
 * `notify()` is the whole point of this handler.
 *
 * It also subscribes to the device module's *suspicious* determination rather
 * than `AUTH_EVENTS.USER_LOGGED_IN`: that event fires on every single login, and
 * its `deviceId` is hardcoded null at the publish site.
 */
@Injectable()
export class SecurityNotificationListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly notifications: NotificationService,
    private readonly guard: NotificationGuard,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SuspiciousLoginDetectedEvent>(DEVICE_EVENTS.SUSPICIOUS_LOGIN, (e) =>
      this.onSuspiciousLogin(e),
    );
    this.bus.subscribe<UserPasswordChangedEvent>(AUTH_EVENTS.USER_PASSWORD_CHANGED, (e) =>
      this.onPasswordChanged(e),
    );
  }

  private async onSuspiciousLogin(e: SuspiciousLoginDetectedEvent): Promise<void> {
    const { userId, deviceId, reason, ip, country } = e.payload;

    await this.guard.once(`login:${userId}:${deviceId}`, GUARD_TTL.LOGIN, async () => {
      // Row only — the push is DeviceService's job. See the class doc.
      await this.notifications.create({
        userId,
        type: NotificationType.SECURITY_NEW_LOGIN,
        entityType: 'device',
        entityId: deviceId,
        data: { reason, ip, country },
      });
    });
  }

  private async onPasswordChanged(e: UserPasswordChangedEvent): Promise<void> {
    const { userId } = e.payload;

    await this.notifications.create({
      userId,
      type: NotificationType.SECURITY_PASSWORD_CHANGED,
      entityType: 'account',
      entityId: null,
      data: {},
    });

    // Nothing else notifies on a password change, so this one does push. SECURITY
    // maps to `null` in CATEGORY_SWITCH and is therefore never suppressed —
    // correct: an attacker who just changed the password must not be able to hide
    // that fact from the owner. No rate-limit check for the same reason.
    await this.notifications.notify(userId, {
      category: PUSH_CATEGORIES.SECURITY,
      title: 'Password changed',
      body: 'Your account password was changed. If this wasn\'t you, secure your account now.',
      badge: 'unread',
      data: { type: 'security_password_changed' },
    });
  }
}
```

- [ ] **Step 5: Register and verify**

Add `SecurityNotificationListener` to `notification.module.ts` providers.

Run: `npx jest src/modules/notification src/modules/auth src/modules/device && npx tsc --noEmit`
Expected: green, and `auth.service.spec.ts` plus `device.service.spec.ts` still pass. Stop for review.

---

### Task 11: Flutter type, category, settings, and deep-link wiring

**Files:**
- Modify: `lib/features/notifications/domain/entities/notification_type.dart`
- Modify: `lib/features/notifications/domain/entities/notification_category.dart`
- Modify: `lib/features/notifications/presentation/screens/notification_settings_screen.dart`
- Modify: `lib/features/notifications/deep_links/deep_link_router.dart`
- Modify: `lib/features/notifications/presentation/widgets/notification_l10n.dart`
- Test: `test/features/notifications/domain_producers_test.dart` (create)

**Interfaces:**
- Consumes: the 20 `NotificationType` names from Task 4 and the four `PushCategory` values from Task 2.

- [ ] **Step 1: Write the failing tests**

Cover: every new API type string parses to its enum value; each maps to the right `NotificationCategory` (`wallet`, `games`, `vip`, `family`); an unrecognised string still returns the `unknown` fallback rather than throwing; each new type resolves to a deep-link route; every new type has a non-empty title string.

- [ ] **Step 2: Run and confirm failure**

Run: `flutter test test/features/notifications/domain_producers_test.dart`
Expected: FAIL — new enum values do not exist.

- [ ] **Step 3: Add the type values and category mapping**

Add the 20 values to `notification_type.dart` with their exact server API strings, keeping the `unknown` fallback. Map them in `notification_category.dart` to the already-present `wallet`, `games`, `vip`, `family` buckets — those enum values exist, only the type→category mapping is missing.

- [ ] **Step 4: Add settings toggles and deep links**

Add four toggles to `notification_settings_screen.dart` bound to `walletEvents`, `gameEvents`, `vipEvents`, `familyEvents`. Add routes in `deep_link_router.dart`: wallet types → wallet screen (with `transactionId`), game types → game/match screen (`sessionId`/`matchId`), VIP → VIP screen, family → family screen (`familyId`). Add title/body strings in `notification_l10n.dart`.

- [ ] **Step 5: Verify**

Run: `flutter test && flutter analyze`
Expected: all tests pass including the three existing notification suites; zero analyzer issues. Stop for review.

---

### Task 12: Full-system verification

- [ ] **Step 1: Backend suite**

Run: `npx jest --runInBand`
Expected: zero failures. Pay attention to `audio-rooms`, `video-rooms`, `chat`, `wallet`, `games`, `families`, `social` — the spec requires no regressions there.

- [ ] **Step 2: Types and lint**

Run: `npx tsc --noEmit && npx eslint src --max-warnings=0`
Expected: clean.

- [ ] **Step 3: Migration sanity**

Run: `npx prisma migrate status`
Expected: no drift; both new migrations applied and additive only.

- [ ] **Step 4: Flutter suite**

Run: `flutter test && flutter analyze`
Expected: clean.

- [ ] **Step 5: Channel parity, both sides**

Run: `npx jest push-channels.parity` then `flutter test test/core/push_channels_parity_test.dart`
Expected: both green. If one fails, the two channel lists have drifted and Android pushes for the drifted category would silently vanish — fix before shipping.

- [ ] **Step 6: Report and stop**

Summarise what was implemented, what was verified with actual command output, and restate the two deployment notes: ship the mobile release before or alongside the server so new-category pushes are not dropped on Android, and confirm `COINS_DEDUCTED` volume in staging before trusting it in production. **Do not commit** — leave everything staged-free for the user.
