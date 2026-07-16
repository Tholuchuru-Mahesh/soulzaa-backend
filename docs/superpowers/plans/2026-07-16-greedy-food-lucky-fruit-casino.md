# Greedy Food & Lucky Fruit (House-Banked Casino) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port two house-banked casino games (Greedy Food, Lucky Fruit) into the new NestJS backend (`soulzaa-backend`) and Flutter app (`soulzaa-mobile`), reproducing the old gameplay, math, economy, and UI exactly, with money-safety hardening.

**Architecture:** A dedicated `casino` module (backend) + `casino` feature (Flutter) that live *alongside* the escrow-based `games` platform and reuse only `WalletService`, the Socket.IO infra (`BaseGateway`/`SocketManager`), and the Flutter shell atoms + posters. Global 24/7 rounds (30s bet → 10s spin → 5s results) run under a Redis leader-lock; a server-side liability engine picks the lowest-payout outcome; wins are server-funded GOLD credits (`stake × multiplier`).

**Tech Stack:** NestJS 10, Prisma, Socket.IO (namespaced gateways), Redis (ioredis via `RedisService`), Jest; Flutter + Riverpod v3 + Freezed + Flame (`flame ^1.37`), `go_router`, `google_fonts` (Outfit).

**Spec:** `docs/superpowers/specs/2026-07-16-greedy-food-lucky-fruit-casino-design.md`

## Global Constraints

- **NO git commands anywhere** (user instruction). Do not stage, commit, branch, push, or checkout. Each task ends with a **verification checkpoint** (run tests/analyze), not a commit.
- **DB migration is generated as a file only — never auto-applied.** Do not run `prisma migrate dev/deploy` or `prisma db push` against any database. Generate the SQL migration file and stop.
- **Currency is GOLD** (`WalletCurrency.GOLD` → `wallets.goldBalance`). Never free coins.
- **Outcome selection = liability engine**: lowest total payout wins; ties broken uniformly at random via `node:crypto` `randomInt`; uniform random when there are zero bets.
- **Chips whitelist = `[100, 500, 1000, 10000, 50000]`** for both games. Lucky Fruit additionally caps a player at **6 distinct symbols per round**. No cap on total stake.
- **Phase durations:** betting 30s, spinning 10s, results 5s. History length 8, top winners 3.
- **Exact socket event names** from the old app (listed per task) — do not rename.
- **Money math is exact**; the only intentional deviations from old behavior are the 5 money-safety fixes (atomic settlement, refund-on-failure, ledger for both games, Greedy summation fix, Lucky roundId validation).
- **Idempotency keys:** bet `casino-bet:{roundId}:{userId}:{item}`; win `casino-win:{roundId}:{betId}`; refund `casino-refund:{roundId}:{betId}`.
- **Pixel source of truth for UI:** the old HUD/icon files under `/Users/lt611-18/Soulzaa_new_2026-1/lib/...`. UI-port tasks copy and rewire those; do not redesign.
- After each backend task: `npm run lint && npx tsc --noEmit` must stay green for touched files. After each Flutter task: `dart analyze` must be clean. Final task runs the full build.

---

## File Structure

**Backend — `src/modules/casino/`**
- `constants/casino.constants.ts` — namespace, rooms, durations, chips, event names, multiplier tables, class sets.
- `engines/liability-selector.ts` — pure min-liability outcome picker.
- `engines/greedy-food.engine.ts` — Greedy items/multipliers/bonus rules/outcome selection (pure).
- `engines/lucky-fruit.engine.ts` — Lucky symbols/multipliers/lucky-segment rules/outcome selection (pure).
- `repositories/casino.repository.ts` — CasinoRound/CasinoBet persistence + win-history + `runInTransaction`.
- `services/casino.service.ts` — bet validation + GOLD debit; atomic settlement + refund; win history.
- `services/casino-round.state.ts` — in-memory per-game round state (held by the leader).
- `services/casino-loop.service.ts` — 1s tick per game under Redis leader-lock; phase transitions; broadcast.
- `gateway/casino.gateway.ts` — inbound `@WebSocketGateway('/casino')` extends `BaseGateway`.
- `dto/casino.dto.ts` — place-bet payload validation.
- `casino.module.ts` — wires the above; imports Wallet, Socket, Redis, Prisma modules.
- Tests: `engines/*.spec.ts`, `services/casino.service.spec.ts`, `services/casino-loop.service.spec.ts`.

**Backend — shared edits**
- `prisma/schema/casino.prisma` (new) — `CasinoGame`, `CasinoRoundStatus`, `CasinoBetStatus`, `CasinoRound`, `CasinoBet`.
- `prisma/schema/wallet.prisma` — add `CASINO_BET`, `CASINO_WIN`, `CASINO_REFUND` to `WalletTxnReason`.
- `prisma/schema/games.prisma` — add `GREEDY_FOOD`, `LUCKY_FRUIT` to `GameCode`.
- `src/modules/games/constants/games.constants.ts` — 2 new `GAME_CATALOG_SEED` entries (PREMIUM/GOLD).
- `src/app.module.ts` — register `CasinoModule`.

**Frontend — `lib/features/casino/`**
- `data/casino_socket_service.dart` — connects `/casino`, typed emit/on.
- `domain/entities/casino_enums.dart` — `GreedyFoodItem`, `LuckyFruitSymbol`, `CasinoPhase`.
- `domain/entities/casino_round_state.dart` — immutable UI state.
- `presentation/controllers/greedy_food_controller.dart` / `lucky_fruit_controller.dart` — Riverpod `Notifier`.
- `presentation/screens/greedy_food_screen.dart` / `lucky_fruit_screen.dart` — ported tables.
- `presentation/screens/greedy_food_win_history_screen.dart` / `lucky_fruit_win_history_screen.dart`.
- `presentation/widgets/` — ported painters (wheel, food/fruit icons, poker chip, results card).

**Frontend — shared edits**
- `lib/features/games/domain/entities/game_enums.dart` — add `greedyFood`, `luckyFruit` to `GameCode`.
- `lib/core/routing/route_paths.dart` + `app_router.dart` — casino routes.
- `lib/features/games/presentation/screens/games_dashboard_screen.dart` — casino card tap → casino route.

---

## PHASE A — BACKEND

### Task 1: Prisma models, wallet reasons, GameCode values, migration file

**Files:**
- Create: `prisma/schema/casino.prisma`
- Modify: `prisma/schema/wallet.prisma` (enum `WalletTxnReason`)
- Modify: `prisma/schema/games.prisma` (enum `GameCode`, lines 22-31)

**Interfaces:**
- Produces: Prisma client types `CasinoGame`, `CasinoRoundStatus`, `CasinoBetStatus`, `CasinoRound`, `CasinoBet`; `WalletTxnReason.CASINO_BET|CASINO_WIN|CASINO_REFUND`; `GameCode.GREEDY_FOOD|LUCKY_FRUIT`.

- [ ] **Step 1: Create `prisma/schema/casino.prisma`**

```prisma
/// House-banked casino games (Greedy Food, Lucky Fruit). Separate from the
/// escrow-based `games` models: payouts are server-funded (stake × multiplier),
/// not pot redistributions. See docs/superpowers/specs/2026-07-16-*.md.
enum CasinoGame {
  GREEDY_FOOD
  LUCKY_FRUIT
}

enum CasinoRoundStatus {
  BETTING
  SPINNING
  SETTLED
  ABORTED
}

enum CasinoBetStatus {
  PLACED
  WON
  LOST
  REFUNDED
}

model CasinoRound {
  id             String            @id @default(uuid()) @db.Uuid
  game           CasinoGame
  status         CasinoRoundStatus @default(BETTING)
  winningOutcome String?
  createdAt      DateTime          @default(now())
  settledAt      DateTime?
  bets           CasinoBet[]

  @@index([game, status])
  @@map("casino_rounds")
}

model CasinoBet {
  id           String          @id @default(uuid()) @db.Uuid
  roundId      String          @db.Uuid
  round        CasinoRound     @relation(fields: [roundId], references: [id])
  userId       String          @db.Uuid
  game         CasinoGame
  betItem      String
  betAmount    BigInt
  status       CasinoBetStatus @default(PLACED)
  payoutAmount BigInt          @default(0)
  betTxnId     String?
  winTxnId     String?
  createdAt    DateTime        @default(now())
  settledAt    DateTime?

  @@index([userId, game, status])
  @@index([roundId])
  @@map("casino_bets")
}
```

- [ ] **Step 2: Add wallet reasons** — in `prisma/schema/wallet.prisma`, inside `enum WalletTxnReason { ... }` (after `SPIN_WHEEL_REWARD`), add:

```prisma
  CASINO_BET
  CASINO_WIN
  CASINO_REFUND
```

- [ ] **Step 3: Add GameCode values** — in `prisma/schema/games.prisma`, inside `enum GameCode { ... }` (after `DOMINO`), add:

```prisma
  GREEDY_FOOD
  LUCKY_FRUIT
```

- [ ] **Step 4: Validate schema + regenerate client (NO migrate apply)**

Run: `cd /Users/lt611-18/soulzaa-backend && npx prisma validate && npx prisma generate`
Expected: "The schema at prisma/schema is valid" and "Generated Prisma Client".

- [ ] **Step 5: Generate the migration SQL file WITHOUT applying it**

Run: `cd /Users/lt611-18/soulzaa-backend && npx prisma migrate diff --from-schema-datasource prisma/schema/schema.prisma --to-schema-datamodel prisma/schema --script > prisma/schema/migrations/casino_greedy_lucky.sql`
Expected: a `.sql` file containing `CREATE TABLE "casino_rounds"`, `CREATE TABLE "casino_bets"`, and `ALTER TYPE "WalletTxnReason" ADD VALUE ...`, `ALTER TYPE "GameCode" ADD VALUE ...`. Do **not** run the SQL.
> If the repo's migrations live elsewhere or use a different flow, generate the equivalent file in the project's migrations directory. Never execute it.

- [ ] **Step 6: Checkpoint (no git)** — confirm `npx tsc --noEmit` still passes (Prisma types resolve). Record the migration file path for the handover notes.

---

### Task 2: Casino constants

**Files:**
- Create: `src/modules/casino/constants/casino.constants.ts`
- Test: `src/modules/casino/constants/casino.constants.spec.ts`

**Interfaces:**
- Produces: `CASINO_NAMESPACE`, `CASINO_ROOMS`, `PHASE_SECONDS`, `CASINO_CHIPS`, `LUCKY_MAX_SYMBOLS`, `HISTORY_LEN`, `TOP_WINNERS`, `GREEDY_MULTIPLIERS`, `LUCKY_MULTIPLIERS`, `GREEDY_VEG`, `GREEDY_NONVEG`, `LUCKY_SMALL`, `LUCKY_BIG`, `GREEDY_ITEMS`, `LUCKY_BETTABLE`, `LUCKY_OUTCOMES`, `CASINO_EVENTS`.

- [ ] **Step 1: Write the failing test**

```ts
import {
  CASINO_CHIPS, GREEDY_MULTIPLIERS, LUCKY_MULTIPLIERS, GREEDY_ITEMS,
  LUCKY_BETTABLE, LUCKY_OUTCOMES, PHASE_SECONDS,
} from './casino.constants';

describe('casino constants', () => {
  it('has the 5 whitelisted chips', () => {
    expect(CASINO_CHIPS).toEqual([100, 500, 1000, 10000, 50000]);
  });
  it('greedy multipliers match old app', () => {
    expect(GREEDY_MULTIPLIERS).toMatchObject({
      carrot: 5, corn: 5, broccoli: 5, tomato: 5,
      burger: 10, chicken: 15, mutton: 25, crab: 45,
      vegSalad: 5, nonVegSalad: 10,
    });
    expect(GREEDY_ITEMS).toHaveLength(10);
  });
  it('lucky multipliers match old app; lucky segments not bettable', () => {
    expect(LUCKY_MULTIPLIERS).toMatchObject({
      pineapple: 5, kiwi: 5, blueberry: 5, peach: 5,
      pear: 10, coconut: 15, dragonFruit: 25, muskmelon: 45,
    });
    expect(LUCKY_BETTABLE).toHaveLength(8);
    expect(LUCKY_OUTCOMES).toHaveLength(10);
    expect(LUCKY_BETTABLE).not.toContain('smallLucky');
    expect(LUCKY_OUTCOMES).toContain('smallLucky');
  });
  it('phase durations 30/10/5', () => {
    expect(PHASE_SECONDS).toEqual({ betting: 30, spinning: 10, results: 5 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/lt611-18/soulzaa-backend && npx jest src/modules/casino/constants -c jest.config.js 2>/dev/null || npx jest casino.constants`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `casino.constants.ts`**

```ts
export const CASINO_NAMESPACE = '/casino';

export const CASINO_ROOMS = {
  GREEDY_FOOD: 'greedy_food_global',
  LUCKY_FRUIT: 'lucky_fruit_global',
} as const;

export const PHASE_SECONDS = { betting: 30, spinning: 10, results: 5 } as const;
export type CasinoPhase = keyof typeof PHASE_SECONDS;

export const CASINO_CHIPS = [100, 500, 1000, 10000, 50000] as const;
export const LUCKY_MAX_SYMBOLS = 6;
export const HISTORY_LEN = 8;
export const TOP_WINNERS = 3;

// --- Greedy Food ---
export const GREEDY_MULTIPLIERS: Record<string, number> = {
  carrot: 5, corn: 5, broccoli: 5, tomato: 5,
  burger: 10, chicken: 15, mutton: 25, crab: 45,
  vegSalad: 5, nonVegSalad: 10,
};
export const GREEDY_ITEMS = Object.keys(GREEDY_MULTIPLIERS); // all 10 bettable + outcomes
export const GREEDY_VEG = ['carrot', 'corn', 'broccoli', 'tomato'];
export const GREEDY_NONVEG = ['burger', 'chicken', 'mutton', 'crab'];

// --- Lucky Fruit ---
export const LUCKY_MULTIPLIERS: Record<string, number> = {
  pineapple: 5, kiwi: 5, blueberry: 5, peach: 5,
  pear: 10, coconut: 15, dragonFruit: 25, muskmelon: 45,
  smallLucky: 0, bigLucky: 0,
};
export const LUCKY_SMALL = ['pineapple', 'kiwi', 'blueberry', 'peach'];
export const LUCKY_BIG = ['pear', 'coconut', 'dragonFruit', 'muskmelon'];
export const LUCKY_BETTABLE = [...LUCKY_SMALL, ...LUCKY_BIG]; // 8
export const LUCKY_OUTCOMES = [...LUCKY_BETTABLE, 'smallLucky', 'bigLucky']; // 10

export const CASINO_EVENTS = {
  GREEDY: {
    JOIN: 'join_greedy_food',
    LEAVE: 'leave_greedy_food',
    BET: 'place_casino_bet',
    HISTORY_REQ: 'get_greedy_food_win_history',
    SYNC: 'greedy_food_sync',
    TICK: 'greedy_food_tick',
    NEW_ROUND: 'greedy_food_new_round',
    SPIN: 'greedy_food_spin',
    RESULTS: 'greedy_food_results',
    POOL: 'greedy_food_pool_update',
    BET_OK: 'bet_placed_success',
    HISTORY: 'greedy_food_win_history',
  },
  LUCKY: {
    JOIN: 'join_lucky_fruit',
    LEAVE: 'leave_lucky_fruit',
    BET: 'place_lucky_fruit_bet',
    HISTORY_REQ: 'get_lucky_fruit_win_history',
    SYNC: 'lucky_fruit_sync',
    TICK: 'lucky_fruit_tick',
    RESULT: 'lucky_fruit_result',
    SETTLEMENT: 'lucky_fruit_settlement',
    POOL: 'lucky_fruit_pool_update',
    BET_OK: 'lucky_fruit_bet_placed',
    HISTORY: 'lucky_fruit_win_history',
  },
  ERROR: 'casino_error',
} as const;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest casino.constants`
Expected: PASS (4 tests).

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean.

---

### Task 3: Liability selector (pure)

**Files:**
- Create: `src/modules/casino/engines/liability-selector.ts`
- Test: `src/modules/casino/engines/liability-selector.spec.ts`

**Interfaces:**
- Produces: `type CasinoBetLike = { item: string; amount: number };` and `pickLowestLiability(outcomes: string[], bets: CasinoBetLike[], effMult: (item: string, outcome: string) => number, rng?: (n: number) => number): string`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

```ts
import { pickLowestLiability, CasinoBetLike } from './liability-selector';

// exact-match effMult: pays 10x only when bet item === outcome
const effMult = (item: string, outcome: string) => (item === outcome ? 10 : 0);

describe('pickLowestLiability', () => {
  it('picks the outcome that pays the least', () => {
    const bets: CasinoBetLike[] = [{ item: 'a', amount: 100 }]; // only 'a' bet
    // liability(a)=1000, liability(b)=0 -> must pick 'b'
    const out = pickLowestLiability(['a', 'b'], bets, effMult);
    expect(out).toBe('b');
  });
  it('is deterministic given an rng for tie-breaks (all-zero liabilities)', () => {
    const out = pickLowestLiability(['a', 'b', 'c'], [], effMult, () => 2);
    expect(out).toBe('c'); // rng returns index 2
  });
  it('breaks ties only among minimum-liability outcomes', () => {
    const bets: CasinoBetLike[] = [{ item: 'a', amount: 100 }];
    // a=1000, b=0, c=0 -> candidates [b,c]; rng()=0 -> 'b'
    const out = pickLowestLiability(['a', 'b', 'c'], bets, effMult, () => 0);
    expect(out).toBe('b');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest liability-selector`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `liability-selector.ts`**

```ts
import { randomInt } from 'node:crypto';

export type CasinoBetLike = { item: string; amount: number };

/**
 * House-protective outcome selection. For each candidate outcome, sum the total
 * the house would pay out; choose an outcome with the minimum total. Ties (incl.
 * the zero-bets case where every outcome pays 0) are broken uniformly at random.
 *
 * @param rng test seam: given n, returns an int in [0, n). Defaults to crypto.randomInt.
 */
export function pickLowestLiability(
  outcomes: string[],
  bets: CasinoBetLike[],
  effMult: (item: string, outcome: string) => number,
  rng: (n: number) => number = (n) => randomInt(n),
): string {
  let min = Number.POSITIVE_INFINITY;
  const liabilities = outcomes.map((o) => {
    let total = 0;
    for (const b of bets) total += b.amount * effMult(b.item, o);
    if (total < min) min = total;
    return total;
  });
  const candidates = outcomes.filter((_, i) => liabilities[i] === min);
  return candidates[rng(candidates.length)];
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest liability-selector`
Expected: PASS (3 tests).

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean.

---

### Task 4: Greedy Food engine (pure)

**Files:**
- Create: `src/modules/casino/engines/greedy-food.engine.ts`
- Test: `src/modules/casino/engines/greedy-food.engine.spec.ts`

**Interfaces:**
- Consumes: constants from Task 2; `pickLowestLiability`, `CasinoBetLike` from Task 3.
- Produces: `greedyEffectiveMultiplier(betItem: string, outcome: string): number`, `isGreedyBettable(item: string): boolean`, `selectGreedyOutcome(bets: CasinoBetLike[], rng?): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { greedyEffectiveMultiplier, isGreedyBettable, selectGreedyOutcome } from './greedy-food.engine';

describe('greedy-food engine', () => {
  it('exact-match pays the bet item multiplier', () => {
    expect(greedyEffectiveMultiplier('crab', 'crab')).toBe(45);
    expect(greedyEffectiveMultiplier('carrot', 'carrot')).toBe(5);
  });
  it('vegSalad outcome pays veg bets at the BET item multiplier', () => {
    expect(greedyEffectiveMultiplier('carrot', 'vegSalad')).toBe(5);
    expect(greedyEffectiveMultiplier('burger', 'vegSalad')).toBe(0);
  });
  it('nonVegSalad outcome pays non-veg bets at the BET item multiplier (crab still 45x)', () => {
    expect(greedyEffectiveMultiplier('crab', 'nonVegSalad')).toBe(45);
    expect(greedyEffectiveMultiplier('carrot', 'nonVegSalad')).toBe(0);
  });
  it('all 10 items are bettable incl. salads', () => {
    expect(isGreedyBettable('vegSalad')).toBe(true);
    expect(isGreedyBettable('nonVegSalad')).toBe(true);
    expect(isGreedyBettable('nope')).toBe(false);
  });
  it('spins to the lowest-liability outcome', () => {
    // only crab bet -> any outcome that does NOT pay crab has liability 0
    const out = selectGreedyOutcome([{ item: 'crab', amount: 100 }], () => 0);
    expect(greedyEffectiveMultiplier('crab', out)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest greedy-food.engine` → FAIL.

- [ ] **Step 3: Implement `greedy-food.engine.ts`**

```ts
import {
  GREEDY_MULTIPLIERS, GREEDY_ITEMS, GREEDY_VEG, GREEDY_NONVEG,
} from '../constants/casino.constants';
import { pickLowestLiability, CasinoBetLike } from './liability-selector';

export function isGreedyBettable(item: string): boolean {
  return item in GREEDY_MULTIPLIERS; // all 10 keys are bettable
}

/** Payout is always the BET item's own multiplier, gated by the win rule. */
export function greedyEffectiveMultiplier(betItem: string, outcome: string): number {
  const win =
    outcome === betItem ||
    (outcome === 'vegSalad' && GREEDY_VEG.includes(betItem)) ||
    (outcome === 'nonVegSalad' && GREEDY_NONVEG.includes(betItem));
  return win ? (GREEDY_MULTIPLIERS[betItem] ?? 0) : 0;
}

export function selectGreedyOutcome(
  bets: CasinoBetLike[],
  rng?: (n: number) => number,
): string {
  return pickLowestLiability(GREEDY_ITEMS, bets, greedyEffectiveMultiplier, rng);
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx jest greedy-food.engine` → PASS (5 tests).

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean.

---

### Task 5: Lucky Fruit engine (pure)

**Files:**
- Create: `src/modules/casino/engines/lucky-fruit.engine.ts`
- Test: `src/modules/casino/engines/lucky-fruit.engine.spec.ts`

**Interfaces:**
- Consumes: constants (Task 2), `pickLowestLiability`/`CasinoBetLike` (Task 3).
- Produces: `luckyEffectiveMultiplier(betSymbol: string, outcome: string): number`, `isLuckyBettable(symbol: string): boolean`, `selectLuckyOutcome(bets: CasinoBetLike[], rng?): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { luckyEffectiveMultiplier, isLuckyBettable, selectLuckyOutcome } from './lucky-fruit.engine';

describe('lucky-fruit engine', () => {
  it('exact match pays own multiplier', () => {
    expect(luckyEffectiveMultiplier('muskmelon', 'muskmelon')).toBe(45);
  });
  it('smallLucky pays small fruits at 5x', () => {
    expect(luckyEffectiveMultiplier('kiwi', 'smallLucky')).toBe(5);
    expect(luckyEffectiveMultiplier('pear', 'smallLucky')).toBe(0);
  });
  it('bigLucky pays big fruits at their own multiplier', () => {
    expect(luckyEffectiveMultiplier('dragonFruit', 'bigLucky')).toBe(25);
    expect(luckyEffectiveMultiplier('kiwi', 'bigLucky')).toBe(0);
  });
  it('lucky segments are not bettable', () => {
    expect(isLuckyBettable('smallLucky')).toBe(false);
    expect(isLuckyBettable('bigLucky')).toBe(false);
    expect(isLuckyBettable('pear')).toBe(true);
  });
  it('spins to the lowest-liability outcome', () => {
    const out = selectLuckyOutcome([{ item: 'muskmelon', amount: 100 }], () => 0);
    expect(luckyEffectiveMultiplier('muskmelon', out)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest lucky-fruit.engine` → FAIL.

- [ ] **Step 3: Implement `lucky-fruit.engine.ts`**

```ts
import {
  LUCKY_MULTIPLIERS, LUCKY_OUTCOMES, LUCKY_BETTABLE, LUCKY_SMALL, LUCKY_BIG,
} from '../constants/casino.constants';
import { pickLowestLiability, CasinoBetLike } from './liability-selector';

export function isLuckyBettable(symbol: string): boolean {
  return LUCKY_BETTABLE.includes(symbol);
}

export function luckyEffectiveMultiplier(betSymbol: string, outcome: string): number {
  if (outcome === betSymbol) return LUCKY_MULTIPLIERS[betSymbol] ?? 0;
  if (outcome === 'smallLucky' && LUCKY_SMALL.includes(betSymbol)) return 5;
  if (outcome === 'bigLucky' && LUCKY_BIG.includes(betSymbol)) return LUCKY_MULTIPLIERS[betSymbol] ?? 0;
  return 0;
}

export function selectLuckyOutcome(
  bets: CasinoBetLike[],
  rng?: (n: number) => number,
): string {
  return pickLowestLiability(LUCKY_OUTCOMES, bets, luckyEffectiveMultiplier, rng);
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx jest lucky-fruit.engine` → PASS (5 tests).

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean.

---

### Task 6: Casino repository

**Files:**
- Create: `src/modules/casino/repositories/casino.repository.ts`
- Test: `src/modules/casino/repositories/casino.repository.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (match how `games.repository.ts` injects Prisma — read `src/modules/games/repositories/games.repository.ts` for the exact import path/token).
- Produces:
  - `createRound(game: CasinoGame): Promise<CasinoRound>`
  - `getRound(id: string): Promise<CasinoRound | null>`
  - `createBet(input: { roundId; userId; game; betItem; betAmount: number; betTxnId?: string }, tx?): Promise<CasinoBet>`
  - `listPlacedBets(roundId: string, tx?): Promise<CasinoBet[]>`
  - `countDistinctSymbols(roundId: string, userId: string): Promise<number>`
  - `updateBet(id: string, data: Partial<{ status; payoutAmount: number; winTxnId; settledAt }>, tx?): Promise<void>`
  - `closeRound(id: string, status: CasinoRoundStatus, winningOutcome: string | null, tx?): Promise<void>`
  - `winHistory(userId: string, game: CasinoGame, limit: number): Promise<Array<{ roundId; item; betAmount; payout; multiplier; createdAt }>>`
  - `runInTransaction<T>(fn: (tx) => Promise<T>): Promise<T>`

- [ ] **Step 1: Write the failing test** (mock PrismaService client methods; assert delegation)

```ts
import { CasinoRepository } from './casino.repository';

const prisma = {
  casinoRound: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  casinoBet: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), findMany2: jest.fn() },
  $transaction: jest.fn((fn: any) => fn(prisma)),
} as any;

describe('CasinoRepository', () => {
  const repo = new CasinoRepository(prisma);
  it('creates a round in BETTING', async () => {
    prisma.casinoRound.create.mockResolvedValue({ id: 'r1' });
    await repo.createRound('GREEDY_FOOD' as any);
    expect(prisma.casinoRound.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ game: 'GREEDY_FOOD' }) }),
    );
  });
  it('lists placed bets for a round', async () => {
    prisma.casinoBet.findMany.mockResolvedValue([{ id: 'b1' }]);
    const bets = await repo.listPlacedBets('r1');
    expect(prisma.casinoBet.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roundId: 'r1', status: 'PLACED' } }),
    );
    expect(bets).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest casino.repository` → FAIL.

- [ ] **Step 3: Implement `casino.repository.ts`** — mirror the injection style of `games.repository.ts`. Map Number↔BigInt at the boundary (store `BigInt(amount)`, return `Number(row.betAmount)`). `winHistory` selects `CasinoBet` where `{ userId, game, status: 'WON' }` ordered by `createdAt desc take limit`, returning `{ roundId, item: betItem, betAmount: Number, payout: Number(payoutAmount), multiplier: Math.round(Number(payoutAmount)/Number(betAmount)), createdAt }`. `countDistinctSymbols` = `casinoBet.findMany({ where:{roundId,userId}, distinct:['betItem'], select:{betItem:true} })` then `.length`. `runInTransaction` = `this.prisma.$transaction(fn)`.

```ts
import { Injectable } from '@nestjs/common';
import { CasinoGame, CasinoRoundStatus, CasinoBetStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../infra/prisma/prisma.service'; // match games.repository.ts path

@Injectable()
export class CasinoRepository {
  constructor(private readonly prisma: PrismaService) {}

  runInTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  createRound(game: CasinoGame) {
    return this.prisma.casinoRound.create({ data: { game, status: 'BETTING' } });
  }
  getRound(id: string) {
    return this.prisma.casinoRound.findUnique({ where: { id } });
  }
  createBet(
    input: { roundId: string; userId: string; game: CasinoGame; betItem: string; betAmount: number; betTxnId?: string },
    tx?: Prisma.TransactionClient,
  ) {
    return (tx ?? this.prisma).casinoBet.create({
      data: {
        roundId: input.roundId, userId: input.userId, game: input.game,
        betItem: input.betItem, betAmount: BigInt(input.betAmount), betTxnId: input.betTxnId,
      },
    });
  }
  listPlacedBets(roundId: string, tx?: Prisma.TransactionClient) {
    return (tx ?? this.prisma).casinoBet.findMany({ where: { roundId, status: 'PLACED' } });
  }
  async countDistinctSymbols(roundId: string, userId: string) {
    const rows = await this.prisma.casinoBet.findMany({
      where: { roundId, userId }, distinct: ['betItem'], select: { betItem: true },
    });
    return rows.length;
  }
  async updateBet(
    id: string,
    data: Partial<{ status: CasinoBetStatus; payoutAmount: number; winTxnId: string; settledAt: Date }>,
    tx?: Prisma.TransactionClient,
  ) {
    await (tx ?? this.prisma).casinoBet.update({
      where: { id },
      data: {
        ...(data.status ? { status: data.status } : {}),
        ...(data.payoutAmount != null ? { payoutAmount: BigInt(data.payoutAmount) } : {}),
        ...(data.winTxnId ? { winTxnId: data.winTxnId } : {}),
        ...(data.settledAt ? { settledAt: data.settledAt } : {}),
      },
    });
  }
  async closeRound(id: string, status: CasinoRoundStatus, winningOutcome: string | null, tx?: Prisma.TransactionClient) {
    await (tx ?? this.prisma).casinoRound.update({
      where: { id }, data: { status, winningOutcome, settledAt: new Date() },
    });
  }
  async winHistory(userId: string, game: CasinoGame, limit: number) {
    const rows = await this.prisma.casinoBet.findMany({
      where: { userId, game, status: 'WON' },
      orderBy: { createdAt: 'desc' }, take: limit,
    });
    return rows.map((r) => ({
      roundId: r.roundId, item: r.betItem, betAmount: Number(r.betAmount),
      payout: Number(r.payoutAmount),
      multiplier: Number(r.betAmount) ? Math.round(Number(r.payoutAmount) / Number(r.betAmount)) : 0,
      createdAt: r.createdAt,
    }));
  }
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx jest casino.repository` → PASS.

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean. If the `PrismaService` import path differs, correct it to match `games.repository.ts`.

---

### Task 7: Casino service — bet placement (validation + GOLD debit)

**Files:**
- Create: `src/modules/casino/services/casino.service.ts` (bet placement portion)
- Test: `src/modules/casino/services/casino.service.spec.ts` (bet cases)

**Interfaces:**
- Consumes: `CasinoRepository` (Task 6); `WALLET_SERVICE` token + `WalletService` interface (read `src/modules/wallet/interfaces/wallet.service.interface.ts` and how `games.service.ts` injects it); engines (Tasks 4-5); constants (Task 2); `RedisLockService`/`LockService` used by `games.service.ts` (`withWalletLocks`) — reuse the same lock util.
- Produces: `placeBet(input: { userId; game: CasinoGame; roundId; item; amount; activeRoundId; phase }): Promise<{ balanceAfter: number; betId: string }>`. Throws `CasinoError` (a small class extending Error with a `message` used by the gateway to emit `casino_error`).

- [ ] **Step 1: Write the failing test**

```ts
import { CasinoService, CasinoError } from './casino.service';
import { CASINO_CHIPS } from '../constants/casino.constants';

function makeService(overrides: any = {}) {
  const repo = {
    createBet: jest.fn().mockResolvedValue({ id: 'bet1' }),
    countDistinctSymbols: jest.fn().mockResolvedValue(0),
    ...overrides.repo,
  };
  const wallet = {
    debit: jest.fn().mockResolvedValue({ transactionId: 'tx1', balanceAfter: 900, duplicate: false }),
    ...overrides.wallet,
  };
  const locks = { withLock: (_k: string, fn: any) => fn() };
  return { svc: new CasinoService(repo as any, wallet as any, locks as any), repo, wallet };
}

describe('CasinoService.placeBet', () => {
  const base = { userId: 'u1', game: 'GREEDY_FOOD' as any, roundId: 'r1', activeRoundId: 'r1', phase: 'betting' as const };

  it('rejects when betting is closed', async () => {
    const { svc } = makeService();
    await expect(svc.placeBet({ ...base, phase: 'spinning', item: 'crab', amount: 100 }))
      .rejects.toThrow(CasinoError);
  });
  it('rejects an off-whitelist chip', async () => {
    const { svc } = makeService();
    await expect(svc.placeBet({ ...base, item: 'crab', amount: 250 }))
      .rejects.toThrow(/chip/i);
  });
  it('rejects an invalid item', async () => {
    const { svc } = makeService();
    await expect(svc.placeBet({ ...base, item: 'nope', amount: 100 }))
      .rejects.toThrow(/item|symbol/i);
  });
  it('rejects a roundId mismatch', async () => {
    const { svc } = makeService();
    await expect(svc.placeBet({ ...base, roundId: 'stale', item: 'crab', amount: 100 }))
      .rejects.toThrow(/round/i);
  });
  it('debits GOLD, persists the bet, returns balance', async () => {
    const { svc, wallet, repo } = makeService();
    const res = await svc.placeBet({ ...base, item: 'crab', amount: 100 });
    expect(wallet.debit).toHaveBeenCalledWith(expect.objectContaining({
      currency: 'GOLD', amount: 100, reason: 'CASINO_BET',
      idempotencyKey: 'casino-bet:r1:u1:crab',
    }));
    expect(repo.createBet).toHaveBeenCalled();
    expect(res).toEqual({ balanceAfter: 900, betId: 'bet1' });
  });
  it('enforces Lucky Fruit 6-distinct-symbol cap', async () => {
    const { svc } = makeService({ repo: { countDistinctSymbols: jest.fn().mockResolvedValue(6) } });
    await expect(svc.placeBet({ ...base, game: 'LUCKY_FRUIT', item: 'pear', amount: 100 }))
      .rejects.toThrow(/6 symbols/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest casino.service` → FAIL.

- [ ] **Step 3: Implement the bet-placement portion of `casino.service.ts`**

```ts
import { Inject, Injectable } from '@nestjs/common';
import { CasinoGame, WalletCurrency, WalletTxnReason } from '@prisma/client';
import { CasinoRepository } from '../repositories/casino.repository';
import { WALLET_SERVICE, WalletServiceInterface } from '../../wallet/interfaces/wallet.service.interface'; // match games.service.ts
import { LockService } from '../../../infra/locks/lock.service'; // match games.service.ts import
import {
  CASINO_CHIPS, LUCKY_MAX_SYMBOLS, CasinoPhase,
} from '../constants/casino.constants';
import { isGreedyBettable } from '../engines/greedy-food.engine';
import { isLuckyBettable } from '../engines/lucky-fruit.engine';

export class CasinoError extends Error {}

export interface PlaceBetInput {
  userId: string; game: CasinoGame; roundId: string; item: string; amount: number;
  activeRoundId: string | null; phase: CasinoPhase;
}

@Injectable()
export class CasinoService {
  constructor(
    private readonly repo: CasinoRepository,
    @Inject(WALLET_SERVICE) private readonly wallet: WalletServiceInterface,
    private readonly locks: LockService,
  ) {}

  private bettable(game: CasinoGame, item: string): boolean {
    return game === 'GREEDY_FOOD' ? isGreedyBettable(item) : isLuckyBettable(item);
  }

  async placeBet(input: PlaceBetInput): Promise<{ balanceAfter: number; betId: string }> {
    const { userId, game, roundId, item, amount, activeRoundId, phase } = input;
    if (phase !== 'betting' || !activeRoundId || roundId !== activeRoundId) {
      throw new CasinoError('Betting is locked for this round');
    }
    if (!CASINO_CHIPS.includes(amount as (typeof CASINO_CHIPS)[number])) {
      throw new CasinoError('Invalid chip/bet amount');
    }
    if (!this.bettable(game, item)) {
      throw new CasinoError(game === 'LUCKY_FRUIT' ? 'Invalid symbol' : 'Invalid item');
    }
    if (game === 'LUCKY_FRUIT') {
      const distinct = await this.repo.countDistinctSymbols(roundId, userId);
      // a brand-new symbol beyond the cap is rejected; adding to an existing one is fine
      // (distinct count already includes existing symbols; a 7th new symbol => distinct===6)
      if (distinct >= LUCKY_MAX_SYMBOLS) {
        // Only block if THIS item is new. Cheap check: is it already among this round's bets?
        const already = await this.repo.countDistinctSymbols(roundId, userId); // see note below
        if (already >= LUCKY_MAX_SYMBOLS) {
          throw new CasinoError('You can bet on a maximum of 6 symbols.');
        }
      }
    }

    // Per-user lock so concurrent bets can't oversell the wallet.
    return this.locks.withLock(`casino:bet:${userId}`, async () => {
      const debit = await this.wallet.debit({
        userId, currency: WalletCurrency.GOLD, amount,
        reason: WalletTxnReason.CASINO_BET,
        idempotencyKey: `casino-bet:${roundId}:${userId}:${item}`,
        referenceType: 'casino_round', referenceId: roundId,
        metadata: { game, item }, actorId: userId,
      });
      const bet = await this.repo.createBet({ roundId, userId, game, betItem: item, betAmount: amount, betTxnId: debit.transactionId });
      return { balanceAfter: Number(debit.balanceAfter), betId: bet.id };
    });
  }
}
```

> **Refinement note for the 6-symbol cap:** to match the old app exactly ("adding more to an already-bet symbol is allowed; a 7th *new* symbol is rejected"), add a repo helper `hasSymbol(roundId, userId, item): Promise<boolean>` and reject only when `distinct >= 6 && !hasSymbol`. Implement that helper in Task 6's file if not already present and use it here instead of the double-count shown. Update the test accordingly (add a case: 6 existing symbols + re-bet on an existing symbol succeeds).

- [ ] **Step 4: Run to verify it passes** — Run: `npx jest casino.service` → PASS (bet cases).

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean. Fix wallet/lock import paths to match `games.service.ts` exactly.

---

### Task 8: Casino service — atomic settlement + refund-on-failure

**Files:**
- Modify: `src/modules/casino/services/casino.service.ts` (add settlement)
- Modify: `src/modules/casino/services/casino.service.spec.ts` (settlement cases)

**Interfaces:**
- Consumes: engines (`selectGreedyOutcome`/`selectLuckyOutcome`, `greedyEffectiveMultiplier`/`luckyEffectiveMultiplier`); repo (`listPlacedBets`, `updateBet`, `closeRound`, `runInTransaction`); wallet `credit`; users/profile service for usernames (reuse the identity resolver `games.service.ts` uses — `resolvePublicIdentities`).
- Produces: `settleRound(game: CasinoGame, roundId: string): Promise<{ winningOutcome: string; payouts: Record<string, number>; winners: Array<{ username: string; amount: number }> }>`.

- [ ] **Step 1: Write the failing test**

```ts
// extend casino.service.spec.ts
describe('CasinoService.settleRound', () => {
  it('picks outcome, credits winners atomically, closes round, sums per user', async () => {
    const bets = [
      { id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n, game: 'GREEDY_FOOD' },
      { id: 'b2', userId: 'u1', betItem: 'crab', betAmount: 100n, game: 'GREEDY_FOOD' }, // second bet, same user
    ];
    const repo = {
      listPlacedBets: jest.fn().mockResolvedValue(bets),
      updateBet: jest.fn().mockResolvedValue(undefined),
      closeRound: jest.fn().mockResolvedValue(undefined),
      runInTransaction: jest.fn((fn: any) => fn('TX')),
    };
    const wallet = { credit: jest.fn().mockResolvedValue({ transactionId: 'wtx', balanceAfter: 1, duplicate: false }) };
    const profiles = { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map([['u1', { username: 'Ann' }]])) };
    const svc = new CasinoService(repo as any, wallet as any, { withLock: (_k:any,f:any)=>f() } as any, profiles as any);
    // force outcome = 'crab' by injecting rng that selects it; or stub the engine via a seam.
    const res = await svc.settleRound('GREEDY_FOOD' as any, 'r1', () => 0 /* rng seam if exposed */);
    // If outcome=crab: each bet pays 100*45=4500, user total 9000
    if (res.winningOutcome === 'crab') {
      expect(res.payouts['u1']).toBe(9000);
      expect(wallet.credit).toHaveBeenCalledTimes(2);
    }
    expect(repo.closeRound).toHaveBeenCalledWith('r1', 'SETTLED', res.winningOutcome, 'TX');
  });

  it('refunds all bets and aborts the round if settlement throws', async () => {
    const bets = [{ id: 'b1', userId: 'u1', betItem: 'crab', betAmount: 100n, game: 'GREEDY_FOOD' }];
    const repo = {
      listPlacedBets: jest.fn().mockResolvedValue(bets),
      updateBet: jest.fn(),
      closeRound: jest.fn(),
      runInTransaction: jest.fn(() => { throw new Error('db down'); }),
    };
    const credit = jest.fn().mockResolvedValue({ transactionId: 'r', balanceAfter: 1, duplicate: false });
    const wallet = { credit };
    const svc = new CasinoService(repo as any, wallet as any, { withLock:(_k:any,f:any)=>f() } as any, { resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()) } as any);
    await svc.settleRound('GREEDY_FOOD' as any, 'r1');
    expect(credit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'CASINO_REFUND', idempotencyKey: 'casino-refund:r1:b1' }));
  });
});
```

- [ ] **Step 2: Run to verify it fails** — Run: `npx jest casino.service` → FAIL.

- [ ] **Step 3: Implement `settleRound`** (add to `CasinoService`; add the `profiles` constructor dependency)

```ts
// add to imports
import { selectGreedyOutcome, greedyEffectiveMultiplier } from '../engines/greedy-food.engine';
import { selectLuckyOutcome, luckyEffectiveMultiplier } from '../engines/lucky-fruit.engine';
// add ProfileService (or the identity resolver games.service uses) to the constructor:
//   private readonly profiles: ProfilesIdentityResolver,

private outcomeFor(game: CasinoGame, bets: { item: string; amount: number }[], rng?: (n: number) => number) {
  return game === 'GREEDY_FOOD' ? selectGreedyOutcome(bets, rng) : selectLuckyOutcome(bets, rng);
}
private effMult(game: CasinoGame, item: string, outcome: string) {
  return game === 'GREEDY_FOOD'
    ? greedyEffectiveMultiplier(item, outcome)
    : luckyEffectiveMultiplier(item, outcome);
}

async settleRound(game: CasinoGame, roundId: string, rng?: (n: number) => number) {
  const placed = await this.repo.listPlacedBets(roundId);
  const betLikes = placed.map((b) => ({ item: b.betItem, amount: Number(b.betAmount) }));
  const winningOutcome = this.outcomeFor(game, betLikes, rng);

  const payouts: Record<string, number> = {};
  try {
    await this.repo.runInTransaction(async (tx) => {
      for (const b of placed) {
        const mult = this.effMult(game, b.betItem, winningOutcome);
        const payout = Number(b.betAmount) * mult;
        if (payout > 0) {
          const c = await this.wallet.credit({
            userId: b.userId, currency: WalletCurrency.GOLD, amount: payout,
            reason: WalletTxnReason.CASINO_WIN,
            idempotencyKey: `casino-win:${roundId}:${b.id}`,
            referenceType: 'casino_round', referenceId: roundId,
            metadata: { game, item: b.betItem, outcome: winningOutcome },
          }, tx);
          void c;
          await this.repo.updateBet(b.id, { status: 'WON', payoutAmount: payout, winTxnId: c.transactionId, settledAt: new Date() }, tx);
          payouts[b.userId] = (payouts[b.userId] ?? 0) + payout; // correct per-user summation
        } else {
          await this.repo.updateBet(b.id, { status: 'LOST', settledAt: new Date() }, tx);
        }
      }
      await this.repo.closeRound(roundId, 'SETTLED', winningOutcome, tx);
    });
  } catch (err) {
    // money-safety: refund every bet, abort the round
    for (const b of placed) {
      await this.wallet.credit({
        userId: b.userId, currency: WalletCurrency.GOLD, amount: Number(b.betAmount),
        reason: WalletTxnReason.CASINO_REFUND,
        idempotencyKey: `casino-refund:${roundId}:${b.id}`,
        referenceType: 'casino_round', referenceId: roundId,
      });
      await this.repo.updateBet(b.id, { status: 'REFUNDED', settledAt: new Date() }).catch(() => undefined);
    }
    await this.repo.closeRound(roundId, 'ABORTED', null).catch(() => undefined);
    return { winningOutcome, payouts: {}, winners: [] as Array<{ username: string; amount: number }> };
  }

  const ids = Object.keys(payouts);
  const identities = await this.profiles.resolvePublicIdentities(ids);
  const winners = ids
    .map((uid) => ({ username: identities.get(uid)?.username ?? `Player_${uid.slice(0, 6)}`, amount: payouts[uid] }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  return { winningOutcome, payouts, winners };
}
```

- [ ] **Step 4: Run to verify it passes** — Run: `npx jest casino.service` → PASS.

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean. Confirm the identity-resolver dependency matches what `games.service.ts` uses (import path + method name).

---

### Task 9: Casino service — win history

**Files:**
- Modify: `src/modules/casino/services/casino.service.ts`
- Modify: `src/modules/casino/services/casino.service.spec.ts`

**Interfaces:**
- Produces: `getWinHistory(userId: string, game: CasinoGame): Promise<Array<{ roundId; item; betAmount; payout; multiplier; createdAt }>>`.

- [ ] **Step 1: Failing test**

```ts
it('returns the user win history (last 50)', async () => {
  const repo = { winHistory: jest.fn().mockResolvedValue([{ roundId:'r1', item:'crab', betAmount:100, payout:4500, multiplier:45, createdAt:new Date() }]) };
  const svc = new CasinoService(repo as any, {} as any, {} as any, {} as any);
  const h = await svc.getWinHistory('u1', 'GREEDY_FOOD' as any);
  expect(repo.winHistory).toHaveBeenCalledWith('u1', 'GREEDY_FOOD', 50);
  expect(h[0].multiplier).toBe(45);
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx jest casino.service`.

- [ ] **Step 3: Implement**

```ts
async getWinHistory(userId: string, game: CasinoGame) {
  return this.repo.winHistory(userId, game, 50);
}
```

- [ ] **Step 4: Run → PASS.** Run: `npx jest casino.service`.

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean.

---

### Task 10: Round state + loop service (Redis leader-lock)

**Files:**
- Create: `src/modules/casino/services/casino-round.state.ts`
- Create: `src/modules/casino/services/casino-loop.service.ts`
- Test: `src/modules/casino/services/casino-loop.service.spec.ts`

**Interfaces:**
- Consumes: `RedisService` (read `src/infra/redis/redis.service.ts` for lock primitives — `set NX PX` / a `tryLock(key, ttl)` helper; if none exists, use `redis.set(key, id, 'PX', ttl, 'NX')`), `CasinoService.settleRound`, `CasinoRepository.createRound`, constants, engines, a broadcast callback.
- Produces: `CasinoLoopService` with `onModuleInit()`; internal `tickGame(game)`; exposes `getState(game): CasinoRoundState` for the gateway sync; emits via an injected `CasinoBroadcaster` interface `{ toRoom(game, event, payload): void }` (implemented by the gateway in Task 11 and set via `setBroadcaster`).
- `CasinoRoundState` = `{ roundId: string; phase: CasinoPhase; secondsRemaining: number; history: string[]; lastWinners: Array<{username;amount}>; poolBets(): Record<string, number>; winningOutcome?: string }`. Active bets are read from the DB (`listPlacedBets`) so a failover reconstructs them.

- [ ] **Step 1: Write the failing test** (drive transitions with an injected clock/leader stub)

```ts
import { CasinoLoopService } from './casino-loop.service';

describe('CasinoLoopService', () => {
  it('transitions betting(30)->spinning(10)->results(5)->new round', async () => {
    const repo = { createRound: jest.fn().mockResolvedValue({ id: 'r1' }), listPlacedBets: jest.fn().mockResolvedValue([]) };
    const service = { settleRound: jest.fn().mockResolvedValue({ winningOutcome: 'crab', payouts: {}, winners: [] }) };
    const redis = { tryLock: jest.fn().mockResolvedValue(true) }; // always leader in test
    const emitted: any[] = [];
    const loop = new CasinoLoopService(repo as any, service as any, redis as any);
    loop.setBroadcaster({ toRoom: (g, e, p) => emitted.push({ g, e, p }) });
    await loop.bootGame('GREEDY_FOOD' as any); // creates first round in BETTING
    for (let i = 0; i < 30; i++) await loop.tickGame('GREEDY_FOOD' as any);
    // after 30 betting ticks -> spin emitted
    expect(emitted.some((x) => x.e === 'greedy_food_spin')).toBe(true);
    for (let i = 0; i < 10; i++) await loop.tickGame('GREEDY_FOOD' as any);
    expect(service.settleRound).toHaveBeenCalled();
    expect(emitted.some((x) => x.e === 'greedy_food_results')).toBe(true);
  });

  it('does nothing when not the leader', async () => {
    const repo = { createRound: jest.fn(), listPlacedBets: jest.fn() };
    const redis = { tryLock: jest.fn().mockResolvedValue(false) };
    const loop = new CasinoLoopService(repo as any, {} as any, redis as any);
    loop.setBroadcaster({ toRoom: jest.fn() });
    await loop.tickGame('GREEDY_FOOD' as any);
    expect(repo.createRound).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx jest casino-loop`.

- [ ] **Step 3: Implement `casino-round.state.ts` and `casino-loop.service.ts`.** The loop keeps per-game `CasinoRoundState`. `onModuleInit` starts one `setInterval(1000)` that, per game, first checks leadership via `redis.tryLock('casino:loop:leader', ttlMs)` (renew each tick); only the leader calls `tickGame`. `tickGame` decrements `secondsRemaining`, emits the per-second `*_tick` (with roundId/phase/secondsRemaining/onlineCount/pool), and on reaching 0 transitions:
  - `betting → spinning`: read placed bets (DB), compute outcome via the engine, set `winningOutcome`, emit `greedy_food_spin` / `lucky_fruit_result` `{ winningOutcome, secondsRemaining: 10 }`, set phase spinning + timer 10.
  - `spinning → results`: call `casinoService.settleRound(game, roundId)`, push outcome to `history` (cap 8), set `lastWinners`, emit `greedy_food_results` / `lucky_fruit_settlement` `{ winningOutcome, winners, payouts, secondsRemaining: 5 }`, phase results + timer 5.
  - `results → betting`: `createRound`, emit `greedy_food_new_round` (Greedy) or `lucky_fruit_sync` (Lucky) + reset timer 30.

  Match the old per-game divergence in *which* event announces a new round (Greedy emits `greedy_food_new_round`; Lucky emits `lucky_fruit_sync`). Use `CASINO_EVENTS` for names. Wrap the outcome computation so `spinning` uses the bets snapshot taken at lock time.

  Provide `getState(game)` returning the current `CasinoRoundState` (+ a `poolBets()` computed from DB placed bets, cached per tick) for the gateway `*_sync`.

- [ ] **Step 4: Run → PASS.** Run: `npx jest casino-loop`.

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean. Confirm the Redis lock primitive matches `RedisService`'s real API.

---

### Task 11: Casino gateway (`/casino` inbound + broadcast)

**Files:**
- Create: `src/modules/casino/gateway/casino.gateway.ts`
- Create: `src/modules/casino/dto/casino.dto.ts`
- Test: `src/modules/casino/gateway/casino.gateway.spec.ts`

**Interfaces:**
- Consumes: `BaseGateway` (read `src/infra/socket/base.gateway.ts`), `SocketManager`, `CasinoService`, `CasinoLoopService` (`getState`, `setBroadcaster`), constants.
- Produces: `CasinoGateway` (namespace `/casino`) implementing `CasinoBroadcaster` (`toRoom(game, event, payload)` → `this.server.to(room).emit(event, payload)`). Wires `loop.setBroadcaster(this)` in `afterInit`.

- [ ] **Step 1: Write the failing test** — unit-test the handler methods directly (construct the gateway with mocked service/loop/manager; call `onGreedyBet(client, body)`; assert `casino_error` emitted on rejection, `bet_placed_success` + `pool_update` on success). Example:

```ts
it('emits casino_error when placeBet throws', async () => {
  const svc = { placeBet: jest.fn().mockRejectedValue(new CasinoError('Insufficient wallet balance')) };
  const loop = { getState: jest.fn().mockReturnValue({ roundId: 'r1', phase: 'betting' }) };
  const gw = new CasinoGateway({} as any, svc as any, loop as any);
  const client: any = { data: { user: { id: 'u1' } }, emit: jest.fn() };
  await gw.onGreedyBet(client, { roundId: 'r1', item: 'crab', amount: 100 });
  expect(client.emit).toHaveBeenCalledWith('casino_error', { message: 'Insufficient wallet balance' });
});
```

- [ ] **Step 2: Run → FAIL.** Run: `npx jest casino.gateway`.

- [ ] **Step 3: Implement `casino.dto.ts` and `casino.gateway.ts`.** DTO: `PlaceCasinoBetDto { roundId: string; item?: string; symbol?: string; amount: number }` (Greedy sends `item`, Lucky sends `symbol`; normalize `item = body.item ?? body.symbol`). Gateway extends `BaseGateway`, `@WebSocketGateway({ namespace: CASINO_NAMESPACE })`, `@WebSocketServer() protected readonly server: Server`. In `afterInit`, call `super.afterInit(server)` then `this.loop.setBroadcaster(this)`. Implement `toRoom(game, event, payload)`. Handlers:
  - `@SubscribeMessage(CASINO_EVENTS.GREEDY.JOIN)` → `manager.joinRoom(client, greedy_food_global)` then emit `greedy_food_sync` from `loop.getState('GREEDY_FOOD')` + this user's `myBets` + `balance` (read via wallet or omit and let client hydrate from `bet_placed_success`).
  - `@SubscribeMessage(CASINO_EVENTS.GREEDY.BET)` → `onGreedyBet`: read `user.id`; `state = loop.getState('GREEDY_FOOD')`; `try { const r = await svc.placeBet({ userId, game:'GREEDY_FOOD', roundId: body.roundId, item: body.item, amount: body.amount, activeRoundId: state.roundId, phase: state.phase }); client.emit('bet_placed_success', { item: body.item, amount: body.amount, balance: r.balanceAfter }); this.toRoom('GREEDY_FOOD','greedy_food_pool_update',{ poolBets: state.poolBets() }); } catch(e){ client.emit('casino_error',{ message: e.message }); }`.
  - `@SubscribeMessage(CASINO_EVENTS.GREEDY.HISTORY_REQ)` → emit `greedy_food_win_history { history: await svc.getWinHistory(userId,'GREEDY_FOOD') }`.
  - `LEAVE` → `manager.leaveRoom`.
  - Mirror all four for Lucky Fruit (`onLuckyBet` uses `symbol`, emits `lucky_fruit_bet_placed`, `lucky_fruit_pool_update` with the pool map **directly** per old, and the 6-symbol cap flows from the service).

- [ ] **Step 4: Run → PASS.** Run: `npx jest casino.gateway`.

- [ ] **Step 5: Checkpoint (no git)** — `npx tsc --noEmit` clean. Confirm `@WebSocketGateway` namespace wiring matches an existing gateway (compare to how `/games` or `/chat` gateways are declared).

---

### Task 12: Module wiring + catalog seed

**Files:**
- Create: `src/modules/casino/casino.module.ts`
- Modify: `src/app.module.ts` (register `CasinoModule`)
- Modify: `src/modules/games/constants/games.constants.ts` (`GAME_CATALOG_SEED` += 2)

**Interfaces:**
- Produces: `CasinoModule` exporting nothing; providers = repo, service, loop, gateway; imports Wallet, Socket infra, Redis, Prisma, Users/Profiles modules (match `games.module.ts` imports).

- [ ] **Step 1: Add the two catalog entries** in `GAME_CATALOG_SEED` (so the dashboard shows the cards):

```ts
  {
    code: GameCode.GREEDY_FOOD,
    name: 'Greedy Food',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 1,
    maxPlayers: 1,
    minStake: 100,
    maxStake: 50_000,
  },
  {
    code: GameCode.LUCKY_FRUIT,
    name: 'Lucky Fruit',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 1,
    maxPlayers: 1,
    minStake: 100,
    maxStake: 50_000,
  },
```

- [ ] **Step 2: Create `casino.module.ts`** (mirror `games.module.ts` providers/imports).

```ts
import { Module } from '@nestjs/common';
import { CasinoRepository } from './repositories/casino.repository';
import { CasinoService } from './services/casino.service';
import { CasinoLoopService } from './services/casino-loop.service';
import { CasinoGateway } from './gateway/casino.gateway';
// import WalletModule, PrismaModule (or global), RedisModule, SocketModule, Users/ProfilesModule as games.module.ts does

@Module({
  imports: [/* WalletModule, SocketModule, RedisModule, UsersModule — copy from games.module.ts */],
  providers: [CasinoRepository, CasinoService, CasinoLoopService, CasinoGateway],
})
export class CasinoModule {}
```

- [ ] **Step 3: Register in `app.module.ts`** — add `CasinoModule` to the `imports` array (next to `GamesModule`).

- [ ] **Step 4: Verify boot + seed** — Run: `cd /Users/lt611-18/soulzaa-backend && npx tsc --noEmit && npm run build`
Expected: build succeeds. (The catalog seeder upserts the two new definitions on boot; the loop starts under the leader-lock.)

- [ ] **Step 5: Checkpoint (no git)** — Run: `npx jest src/modules/casino && npm run lint` → all casino tests pass, lint clean.

---

## PHASE B — FRONTEND (`soulzaa-mobile`)

> All Flutter commands run from `/Users/lt611-18/soulzaa-mobile`. Rendering ports copy the old files under `/Users/lt611-18/Soulzaa_new_2026-1/lib/...` verbatim (colors, sizes, painters, animations), changing only state access to Riverpod.

### Task 13: Add GameCode enum values + codegen

**Files:**
- Modify: `lib/features/games/domain/entities/game_enums.dart` (enum `GameCode`)

**Interfaces:**
- Produces: `GameCode.greedyFood` (`api` `'GREEDY_FOOD'`), `GameCode.luckyFruit` (`api` `'LUCKY_FRUIT'`); `fromApi`/`api` cases; `.name` matches `GamePosterArt.fromName('greedyFood'|'luckyFruit')`.

- [ ] **Step 1: Add enum values + `api`/`fromApi` cases** for `greedyFood`, `luckyFruit`, mirroring the existing pattern in `game_enums.dart`.
- [ ] **Step 2: Run codegen** — Run: `dart run build_runner build --delete-conflicting-outputs`
Expected: regenerates `.g.dart`/`.freezed.dart` with no errors.
- [ ] **Step 3: Verify** — Run: `dart analyze lib/features/games/domain/entities/game_enums.dart`
Expected: No issues.
- [ ] **Step 4: Checkpoint (no git).**

---

### Task 14: Casino socket service

**Files:**
- Create: `lib/features/casino/data/casino_socket_service.dart`
- Test: `test/features/casino/casino_socket_service_test.dart`

**Interfaces:**
- Consumes: the app's socket client (read how `games/ludo/ludo_controller.dart` connects — `socket.connect(SocketNamespaces.games)`; add `SocketNamespaces.casino = '/casino'` to `core/constants/socket_constants.dart`).
- Produces: `CasinoSocketService` with `connect()`, `emit(event, data)`, `on(event, handler)`, `off(event)`, `dispose()`, connected to `/casino`.

- [ ] **Step 1: Add `SocketNamespaces.casino = '/casino'`** to `core/constants/socket_constants.dart`.
- [ ] **Step 2: Write a light test** that constructs the service with a fake socket and asserts `on`/`emit` delegate. (Follow the pattern of existing socket tests if present; otherwise a construction + delegation test.)
- [ ] **Step 3: Implement `CasinoSocketService`** wrapping the shared socket client on the `/casino` namespace.
- [ ] **Step 4: Run** — `flutter test test/features/casino/casino_socket_service_test.dart` → PASS.
- [ ] **Step 5: Checkpoint (no git)** — `dart analyze lib/features/casino/data` clean.

---

### Task 15: Casino enums + round-state entity

**Files:**
- Create: `lib/features/casino/domain/entities/casino_enums.dart`
- Create: `lib/features/casino/domain/entities/casino_round_state.dart`

**Interfaces:**
- Produces: `enum GreedyFoodItem { carrot, corn, broccoli, tomato, vegSalad, burger, nonVegSalad, chicken, mutton, crab }` (**declaration order = wheel segment order**, matching old `greedy_food_core.dart`) with `.name` wire values + `multiplier`; `enum LuckyFruitSymbol { pineapple, kiwi, blueberry, peach, pear, coconut, dragonFruit, muskmelon, smallLucky, bigLucky }` with `.name`, `multiplier`, `label`, `emoji`; `enum CasinoPhase { betting, spinning, results }`; `CasinoRoundState` (immutable) with `phase, secondsRemaining, onlineCount, playerBalance, activeRoundId, poolBets(Map<String,int>), myBets(Map<String,int>), resultsHistory(List<String>), lastWinners(List<({String username,int amount})>), winningOutcome, lastRoundResult`.

- [ ] **Step 1: Port `GreedyFoodItem`/`LuckyFruitSymbol`** from old `*_core.dart` (exact order + multipliers + labels/emojis).
- [ ] **Step 2: Define `CasinoRoundState`** as an immutable class (plain class with `copyWith`, matching how the Ludo state is modeled — check `games/ludo/ludo_controller.dart` for the state style).
- [ ] **Step 3: Verify** — `dart analyze lib/features/casino/domain` clean.
- [ ] **Step 4: Checkpoint (no git).**

---

### Task 16: Greedy Food controller (Riverpod)

**Files:**
- Create: `lib/features/casino/presentation/controllers/greedy_food_controller.dart`
- Test: `test/features/casino/greedy_food_controller_test.dart`

**Interfaces:**
- Consumes: `CasinoSocketService` (Task 14), enums/state (Task 15), `walletSummaryProvider` (gold balance), the socket event constants.
- Produces: `greedyFoodControllerProvider = NotifierProvider<GreedyFoodController, CasinoRoundState>` with methods `enter()`, `selectChip(int)`, `placeBet(GreedyFoodItem)`, `requestWinHistory()`, `leave()`; registers handlers for `greedy_food_sync/tick/new_round/spin/results/pool_update/bet_placed_success/win_history/casino_error` and maps each to state updates (mirror old `greedy_food_game.dart` socket wiring, but as immutable `state = state.copyWith(...)`).

- [ ] **Step 1: Write the failing test** — feed synthetic socket frames into the controller and assert state transitions (e.g. a `greedy_food_tick` sets `secondsRemaining`; a `bet_placed_success` sets `playerBalance`; a `greedy_food_results` freezes `lastRoundResult` and credits balance).
- [ ] **Step 2: Run → FAIL.** `flutter test test/features/casino/greedy_food_controller_test.dart`.
- [ ] **Step 3: Implement the controller** — `Notifier<CasinoRoundState>`; `enter()` reads gold from `walletSummaryProvider`, connects the socket, registers handlers, emits `join_greedy_food`; `placeBet` guards phase+balance then emits `place_casino_bet {roundId, item: item.name, amount: selectedChip}`; on `greedy_food_results` freeze `lastRoundResult` from `payouts[myUserId]`, add to history (cap 8), credit balance, re-emit `join_greedy_food`. Chips `[100,500,1000,10000,50000]`.
- [ ] **Step 4: Run → PASS.** Same command.
- [ ] **Step 5: Checkpoint (no git)** — `dart analyze` clean.

---

### Task 17: Lucky Fruit controller (Riverpod)

**Files:**
- Create: `lib/features/casino/presentation/controllers/lucky_fruit_controller.dart`
- Test: `test/features/casino/lucky_fruit_controller_test.dart`

**Interfaces:**
- Produces: `luckyFruitControllerProvider = NotifierProvider<LuckyFruitController, CasinoRoundState>` with `enter()`, `selectChip(int)`, `placeBet(LuckyFruitSymbol)` (enforces max-6 distinct locally too, matching old `errorNotifier`), `requestWinHistory()`, `leave()`; handles `lucky_fruit_sync/tick/result/settlement/pool_update/bet_placed(lucky_fruit_bet_placed)/win_history/casino_error`; exposes a `spinTick` signal the screen listens to for the chase animation.

- [ ] **Step 1: Failing test** — feed `lucky_fruit_result` and assert phase→spinning + `winningOutcome` set + a spin signal increments; feed `lucky_fruit_settlement` and assert `lastRoundResult` frozen + balance credited.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — mirror Task 16 but with Lucky event names, `place_lucky_fruit_bet {roundId, symbol, amount}`, the 6-distinct-symbol local guard, and a `spinTick` counter for the chase-light reveal. Pool update payload is the map directly.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Checkpoint (no git)** — `dart analyze` clean.

---

### Task 18: Greedy Food table screen (pixel port)

**Files:**
- Create: `lib/features/casino/presentation/screens/greedy_food_screen.dart`
- Create: `lib/features/casino/presentation/widgets/greedy_food_wheel.dart` (Flame game)
- Create: `lib/features/casino/presentation/widgets/greedy_food_icons.dart` (ported painters)
- Create: `lib/features/casino/presentation/widgets/casino_poker_chip.dart` (shared, used by both games)
- Create: `lib/features/casino/presentation/widgets/casino_results_card.dart` (shared)

**Port source (copy verbatim, rewire state to Riverpod):**
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/presentation/.../games/greedy_food_hud_overlay.dart` (full chrome + layout: header gold-gradient title, ROUND pill, online pill, sound toggle; gold timer banner; history strip; chips row; wallet/action bar with LOCK BETS INSTANTLY + REPEAT; results card overlay; Scaffold bg `0xFF120826`, stage `RadialGradient` + ambient glows).
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/core/games/engine/greedy_food_game.dart` (Flame wheel render: center `cx=W/2,cy=H*0.42`, `radius=min(W*0.46,H*0.32)`, gold ring width 22 with `SweepGradient`, 24 chase bulbs, 10 slices with the exact per-index colors, per-slice food icon + `{mult}X` text + gold bet pill, center hub, red pointer; spin physics `AnimationController(10s)` + `Curves.easeOutQuart`, 10 full turns, land winning slice under the top pin; tap-a-slice → bet).
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/core/games/engine/greedy_food_icons.dart` (the 10 procedural `CustomPaint` food icons — copy the whole `GreedyFoodIconRenderer`).

- [ ] **Step 1: Copy the icon renderer** into `greedy_food_icons.dart` unchanged (pure painting; no state).
- [ ] **Step 2: Copy the Flame wheel** into `greedy_food_wheel.dart`; change its data source: instead of reading `game.*` fields, accept a `CasinoRoundState` + callbacks (`onTapItem`, current `myBets`, `winningOutcome`, spin trigger) passed from the screen. Keep all render math/colors identical.
- [ ] **Step 3: Build `greedy_food_screen.dart`** as a `ConsumerStatefulWidget` that `ref.watch`es `greedyFoodControllerProvider`, maps state into the wheel + chrome (ported from the HUD overlay), wires chip taps → `.selectChip`, slice taps → `.placeBet`, menu → `showGameMenu`/win-history nav, and drives the spin `AnimationController` off the `winningOutcome`/phase like the old `_triggerSpin`. Provide the `TickerProvider` to the wheel.
- [ ] **Step 4: Copy `casino_poker_chip.dart` + `casino_results_card.dart`** from the HUD overlay's `_PokerChip`/`_buildResultsCard` (exact colors + chip color map `[100:green,500:purple,1000:blue,10000:red,50000:gold]`, labels `100/500/1K/10K/50K`, results card width 300 gold border).
- [ ] **Step 5: Widget test** — `test/features/casino/greedy_food_screen_test.dart`: pump the screen with an overridden controller in `betting` phase; assert the title "GREEDY FOOD", 5 chips, and the timer banner render. Run: `flutter test test/features/casino/greedy_food_screen_test.dart` → PASS.
- [ ] **Step 6: Checkpoint (no git)** — `dart analyze lib/features/casino` clean.

---

### Task 19: Lucky Fruit table screen (pixel port)

**Files:**
- Create: `lib/features/casino/presentation/screens/lucky_fruit_screen.dart`
- Create: `lib/features/casino/presentation/widgets/lucky_fruit_grid.dart`
- Create: `lib/features/casino/presentation/widgets/lucky_fruit_icons.dart` (ported painters)

**Port source (copy verbatim, rewire to Riverpod):**
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/presentation/.../games/lucky_fruit_hud_overlay.dart` (full screen: Scaffold bg `0xFF0F031A`, stage radial, purple/orange ambient glows; header "LUCKY FRUIT"; gold timer banner; neon side arrows; the 4×5 board — center "WIN UP TO 45x" panel + the exact 14 perimeter cell ring with the documented per-cell symbol/label/color at `(row,col)`; board sizing math `cell=min(min(availW/4,availH/5),118)`; per-cell gradient/gloss/active-scale + gold bet badge; chase-light reveal `_triggerChaseAnimation` walking `activeIndex`; bottom panel history strip + chips (`LuckyFruitChip`) + action bar "BETS LOCK INSTANTLY"; results card).
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/core/games/engine/lucky_fruit_icons.dart` (procedural fruit icons `LuckyFruitIconRenderer` — copy whole).

- [ ] **Step 1: Copy the fruit icon renderer** into `lucky_fruit_icons.dart` unchanged.
- [ ] **Step 2: Build `lucky_fruit_grid.dart`** — the 4×5 `Stack` of `Positioned` cells (exact ring order/colors/labels), fed a `CasinoRoundState` + `activeIndex` (chase) + `onTapCell`. Keep all sizing/colors identical.
- [ ] **Step 3: Build `lucky_fruit_screen.dart`** as a `ConsumerStatefulWidget` watching `luckyFruitControllerProvider`; run the `_chaseTimer` walk off the controller's `spinTick` (listen and animate), map cells taps → `.placeBet`, reuse the shared chip/results-card widgets from Task 18. Port the chrome (header/timer/neon arrows/bottom panel) from the HUD overlay.
- [ ] **Step 4: Widget test** — `test/features/casino/lucky_fruit_screen_test.dart`: pump in `betting`; assert "LUCKY FRUIT", the center "45x" panel, and 5 chips render. Run → PASS.
- [ ] **Step 5: Checkpoint (no git)** — `dart analyze lib/features/casino` clean.

---

### Task 20: Win-history screens (both)

**Files:**
- Create: `lib/features/casino/presentation/screens/greedy_food_win_history_screen.dart`
- Create: `lib/features/casino/presentation/screens/lucky_fruit_win_history_screen.dart`

**Port source:**
- `/Users/lt611-18/Soulzaa_new_2026-1/lib/presentation/.../games/greedy_food_win_history_screen.dart` and `lucky_fruit_win_history_screen.dart` (3-stat summary TOTAL WINS / TOTAL WON / BIGGEST + card list, exact gradients/colors; `_winCard` with food/fruit icon disc, `{mult}X` pill, `+{payout}` green, relative time; empty state).

- [ ] **Step 1: Port both screens**, sourcing data from the controller's win-history list (populated by `requestWinHistory()` → `*_win_history` event). Compute the 3 summary stats from the list.
- [ ] **Step 2: Widget test** — pump each with a stub list of 2 wins; assert the 3 stat cards + 2 win cards render. Run → PASS.
- [ ] **Step 3: Checkpoint (no git)** — `dart analyze` clean.

---

### Task 21: Dashboard entry + routing

**Files:**
- Modify: `lib/core/routing/route_paths.dart` (+ `casinoGreedyFood`, `casinoLuckyFruit` paths)
- Modify: `lib/core/routing/app_router.dart` (register the two full-screen routes)
- Modify: `lib/features/games/presentation/screens/games_dashboard_screen.dart` (casino card tap → casino route)

**Interfaces:**
- Consumes: the screens (Tasks 18-19), `GameCode.greedyFood/luckyFruit` (Task 13), `GamePosterArt` (already wired).

- [ ] **Step 1: Add routes** `/casino/greedy-food` → `GreedyFoodScreen`, `/casino/lucky-fruit` → `LuckyFruitScreen` (portrait; wrap in `PopScope(canPop:false)` confirm-leave like `GameSessionScreen`).
- [ ] **Step 2: Wire the dashboard tap** — in the games dashboard card handler, special-case casino codes: `if (code == GameCode.greedyFood) context.push(RoutePaths.casinoGreedyFood); else if (code == GameCode.luckyFruit) context.push(RoutePaths.casinoLuckyFruit); else _openModeSheet(...)`. (Cards already render because the catalog now returns these definitions and posters exist.)
- [ ] **Step 3: Verify** — Run: `dart analyze` (whole project) → clean.
- [ ] **Step 4: Checkpoint (no git).**

---

### Task 22: Full verification + handover notes

**Files:** none (verification only)

- [ ] **Step 1: Backend gates** — Run: `cd /Users/lt611-18/soulzaa-backend && npm run lint && npx tsc --noEmit && npm test && npm run build`
Expected: lint clean, tsc clean, all Jest tests pass (incl. the whole existing suite — confirm nothing regressed), build succeeds.

- [ ] **Step 2: Frontend gates** — Run: `cd /Users/lt611-18/soulzaa-mobile && dart analyze && flutter test`
Expected: analyze clean, all widget/unit tests pass.

- [ ] **Step 3: Write the handover section** to the top of this plan (or a `HANDOVER.md` in the repo root — no git) listing exactly:
  1. The un-applied migration file path from Task 1 and the command the user must run to apply it (e.g. `npx prisma migrate deploy` after moving the file into a proper migration folder, or `npx prisma db execute --file <path>`), with a warning it touches the DB.
  2. The two manual QA items: on-device visual parity vs the old app; live gold-coin bet → win/loss end-to-end on a running server + device.
  3. Confirmation that no git actions were taken.

- [ ] **Step 4: Report results** — summarize actual command output (pass/fail counts), not assertions. If any gate failed, do not claim done; fix or flag.

---

## Self-Review (completed at plan-write time)

**Spec coverage:** liability engine (Tasks 3-5, 10), exact multipliers/bonus (Tasks 2,4,5), 30/10/5 phases + global rooms + leader-lock (Task 10), inbound `/casino` gateway with exact event names (Task 11), GOLD debit/credit + new wallet reasons + atomic settlement + refund + ledger for both (Tasks 1,7,8), 5-chip whitelist + Lucky 6-symbol cap (Tasks 2,7), win history (Tasks 6,9,11,20), persistence models + migration-file-only (Task 1), dashboard entry + GOLD (Tasks 12,13,21), pixel-faithful UI incl. Flame wheel + grid + chase + icons + chrome + win history (Tasks 15-20), Riverpod wiring (Tasks 16-17), the 5 money-safety fixes (Tasks 7,8), testing conventions (all tasks), no-git + no-auto-migrate (Global Constraints, Tasks 1,22). All spec sections map to tasks.

**Placeholder scan:** the two large UI-port tasks intentionally reference exact old source files instead of inlining ~3,000 lines of Dart (the spec designates those files as the pixel source of truth); every backend money/logic step has complete code. The Lucky 6-symbol cap has an explicit refinement note with the exact helper to add. No `TODO`/`TBD` left as work-defining.

**Type consistency:** `pickLowestLiability`/`CasinoBetLike` (Task 3) reused by engines (4-5); `greedy/luckyEffectiveMultiplier`, `select*Outcome` names consistent across engines, service (8), loop (10); `CasinoService.placeBet`/`settleRound`/`getWinHistory` signatures consistent across service (7-9), gateway (11), loop (10); repo method names consistent across repo (6) and service (7-9); Flutter provider names (`greedyFoodControllerProvider`, `luckyFruitControllerProvider`) and `CasinoRoundState` consistent across controllers (16-17) and screens (18-21).
