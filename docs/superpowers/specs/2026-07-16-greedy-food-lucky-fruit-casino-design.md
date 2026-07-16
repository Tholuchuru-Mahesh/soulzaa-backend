# Design Spec — Greedy Food & Lucky Fruit (House-Banked Casino Games)

**Date:** 2026-07-16
**Status:** Approved (design) — ready for implementation plan
**Author:** pairing session
**Scope:** Port two house-banked casino games (Greedy Food, Lucky Fruit) from the old
Soulzaa stack into the new NestJS backend (`soulzaa-backend`) and new Flutter app
(`soulzaa-mobile`), reproducing the old gameplay, math, economy, and UI exactly, with
targeted money-safety hardening.

> **No git actions** are to be performed for this work (explicit user instruction).
> The DB migration is generated as a file but **not auto-applied**.

---

## 1. Goal

Players open **Greedy Food** or **Lucky Fruit** from the games dashboard and land directly
in a full-screen casino table that behaves **exactly** like the old app: a global, always-on
round (30s bet → 10s spin → 5s results), gold-coin betting on items, a server-chosen winning
item, and multiplier payouts — with pixel-faithful UI (Flame spinning wheel for Greedy, a
4×5 chase-light grid for Lucky) and correct gold-coin **deduction on bet** + **credit on win**.

Success = a player can bet gold, watch the spin/reveal, and have their gold balance move by
exactly the amounts the old app would produce, with the same visuals.

---

## 2. Source of truth (old code — the reference implementation)

**Old backend** `/Users/lt611-18/Soulzaa_new_backend-1`:
- `controller/socket_controllers/greedy_food_socket.js` (486 lines) — Greedy Food server logic.
- `controller/socket_controllers/lucky_fruit_socket.js` (475 lines) — Lucky Fruit server logic.
- `utils/autoMigrate.js` `createCasinoTables()` — `casino_rounds`, `casino_bets` schema.
- `server.js` — loop registration (`initGreedyFoodLoop`, `initLuckyFruitLoop`).

**Old Flutter** `/Users/lt611-18/Soulzaa_new_2026-1`:
- `lib/core/games/engine/greedy_food_core.dart`, `greedy_food_game.dart`, `greedy_food_icons.dart`
- `lib/core/games/engine/lucky_fruit_core.dart`, `lucky_fruit_game.dart`, `lucky_fruit_icons.dart`
- `lib/presentation/.../games/greedy_food_hud_overlay.dart` (~1347 lines) — Greedy full screen.
- `lib/presentation/.../games/lucky_fruit_hud_overlay.dart` (~1600 lines) — Lucky full screen.
- `lib/presentation/.../games/greedy_food_win_history_screen.dart`, `lucky_fruit_win_history_screen.dart`
- `lib/presentation/.../games/widgets/game_menu_popup.dart`, `game_coin.dart`, `game_poster_art.dart`

> The night implementation run MUST re-read the two HUD overlays + icon files for pixel-exact
> colors/layout/animation. This spec captures the **contracts and exact math**; the old
> Flutter files remain the visual source of truth.

---

## 3. Approved decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Outcome selection (RNG) | **Exact liability engine** — spin to the lowest-total-payout outcome; ties broken uniformly at random; uniform random when there are zero bets. House-protective, matches old exactly. |
| 2 | Faithfulness policy | **Exact math + UI, fix money-safety.** Reproduce every player-visible rule/number/multiplier/pixel; but make settlement atomic w/ refund-on-failure, write the ledger for both games, fix the Greedy multi-bet leaderboard summation, and validate roundId on Lucky bets. |
| 3 | Bet amounts | **5-chip whitelist for both** — `100 / 500 / 1,000 / 10,000 / 50,000` gold; Lucky Fruit additionally caps a player at **6 distinct fruits per round**. No cap on total stake. |
| 4 | Realtime transport | **Dedicated inbound `/casino` WebSocket gateway** — bets, per-second ticks, spins, results all over the socket with the old event names. |
| 5 | Server topology | **Multi-instance safe** — the 24/7 loop runs under a **Redis leader-lock**; only one process drives rounds; auto-failover. |
| 6 | Flutter wiring | **Riverpod controllers** (like the Ludo/Carrom ports) with **pixel-identical rendering** ported from the old HUDs. |
| 7 | Entry & coin | **Dashboard card → straight into the table**, bet **GOLD** (`walletSummary.gold`). No mode sheet, no quick-match/friends/vs-computer, no offline mode. |

---

## 4. Architecture

Add a **dedicated `casino` module** (backend) and **`casino` feature** (Flutter) that live
alongside — not inside — the escrow-based `games` platform. They reuse only shared primitives:
`WalletService`, the Socket.IO infra (`BaseGateway`/`SocketManager`), and the Flutter shell atoms
+ posters.

**Why separate, not through `games`:** the `games` settlement path (`validateSettlement`) hard-rejects
`payoutTotal > potAmount` and requires pot reconciliation (`sum(stakes) === potAmount`). Casino wins
**mint** coins (server pays `stake × multiplier` from the house), which those invariants exist to
prevent. Routing casino through `games` would require gutting the anti-cheat that protects Ludo/Carrom.
The two games are 1-player-vs-house, global, round-based — no lobby, seats, teams, turns, or matchmaking.

**Catalog integration:** the two games still appear on the games dashboard (their posters are already
wired in `GamePosterArt`: `GamePoster.greedyFood`, `.luckyFruit`). We add `GREEDY_FOOD` + `LUCKY_FRUIT`
`GameDefinition` rows (PREMIUM / GOLD) so they render as cards; the dashboard tap handler special-cases
casino codes and routes to the casino table route instead of the lobby/session flow.

---

## 5. Backend design (`src/modules/casino/`)

### 5.1 Module layout
```
src/modules/casino/
  casino.module.ts
  constants/casino.constants.ts        # namespace, room names, phase durations, chips, event names, multiplier tables
  engines/greedy-food.engine.ts        # pure: items, multipliers, bonus rules, isWinningBet, effectiveMultiplier, selectOutcome (liability)
  engines/lucky-fruit.engine.ts        # pure: symbols, multipliers, small/big-lucky rules, selectOutcome (liability)
  engines/liability-selector.ts        # shared pure helper: pick min-liability outcome, random tie-break, uniform on no bets
  services/casino.service.ts           # bet validation + real-time GOLD debit; round settlement (atomic, refund-on-fail); win history
  services/casino-loop.service.ts      # 1s tick per game under Redis leader-lock; phase transitions; broadcast
  services/casino-round.state.ts       # in-memory per-game round state (active bets, phase, timer, history) held by the leader
  repositories/casino.repository.ts    # CasinoRound / CasinoBet persistence; win-history query; runInTransaction
  gateway/casino.gateway.ts            # inbound @WebSocketGateway('/casino') extends BaseGateway; @SubscribeMessage handlers
  dto/casino.dto.ts                    # place-bet payload validation
  casino.service.spec.ts               # service tests
  engines/*.spec.ts                    # pure engine tests
```

### 5.2 Round engine (pure) — exact math

**Greedy Food** — 10 bettable items (all bettable, incl. both salads):

| Item | Multiplier | Class |
|------|-----------|-------|
| carrot, corn, broccoli, tomato | 5× | VEG |
| burger | 10× | NON_VEG |
| chicken | 15× | NON_VEG |
| mutton | 25× | NON_VEG |
| crab | 45× | NON_VEG |
| vegSalad | 5× | (bonus/veg) |
| nonVegSalad | 10× | (bonus/nonveg) |

`isWinningBet(betItem, outcome)`:
- `outcome === betItem` → win
- `outcome === 'vegSalad'` AND `betItem ∈ VEG` → win
- `outcome === 'nonVegSalad'` AND `betItem ∈ NON_VEG` → win
- else lose

Payout multiplier is **always the bet item's own multiplier** (`MULTIPLIERS[betItem]`), never the
outcome's. So under a `nonVegSalad` outcome, a `crab` bet still pays **45×**.

**Lucky Fruit** — 8 bettable symbols + 2 outcome-only "lucky" segments:

| Symbol | Multiplier | Class | Bettable |
|--------|-----------|-------|----------|
| pineapple, kiwi, blueberry, peach | 5× | SMALL | yes |
| pear | 10× | BIG | yes |
| coconut | 15× | BIG | yes |
| dragonFruit | 25× | BIG | yes |
| muskmelon | 45× | BIG | yes |
| smallLucky | — | (bonus) | **no** (outcome only) |
| bigLucky | — | (bonus) | **no** (outcome only) |

`effectiveMultiplier(betSymbol, winningSymbol)`:
- `winningSymbol === betSymbol` → `MULTIPLIERS[betSymbol]`
- `winningSymbol === 'smallLucky'` AND `betSymbol ∈ SMALL` → `5`
- `winningSymbol === 'bigLucky'` AND `betSymbol ∈ BIG` → `MULTIPLIERS[betSymbol]`
- else `0`

**Liability outcome selector (shared, house-protective):**
```
outcomes = all outcomes for this game (Greedy: 10; Lucky: 10 incl. smallLucky/bigLucky)
for each outcome o:
    liability(o) = Σ over active bets b of ( b.amount × effectiveMultiplier(b.item, o) )   # 0 for losing bets
minLiability = min over o of liability(o)
candidates = { o : liability(o) === minLiability }
winningOutcome = uniform random choice from candidates
# zero bets ⇒ all liabilities 0 ⇒ all outcomes tie ⇒ uniform random
```
Use `node:crypto` `randomInt` for the tie-break pick (already imported in the games module).

### 5.3 Timing & phases
Per game, a 1-second tick driven by `CasinoLoopService`:
- `betting` — 30s
- `spinning` — 10s
- `results` — 5s
Full cycle ≈ 45s. Rooms: `greedy_food_global`, `lucky_fruit_global` on the `/casino` namespace.
`resultsHistory` keeps the last **8** outcomes; leaderboard keeps top **3** winners of the round.

### 5.4 Leader-lock scheduler
`CasinoLoopService` acquires a Redis lock (e.g. `casino:loop:leader`, short TTL, renewed each tick)
via the existing `RedisService`. Only the lock holder advances rounds and broadcasts ticks. On loss
of leadership (crash/renewal failure) another instance acquires the lock and continues. Round state
that must survive a leadership change lives in Redis / DB (active round id + phase + deadline);
in-memory `activeBets` for the *current* round is reconstructable from `CasinoBet` rows
(`status = PLACED`, current round). This keeps the "exactly one loop" guarantee across instances.

### 5.5 Economy (GOLD, house-banked, hardened)
- **Currency:** GOLD only (`WalletCurrency.GOLD` → `wallets.goldBalance`).
- **New wallet reasons** (add to `WalletTxnReason` in `prisma/schema/wallet.prisma`):
  `CASINO_BET`, `CASINO_WIN`, `CASINO_REFUND`.
- **Bet (real-time debit at placement):** inside the wallet's transactional/idempotent path,
  `wallet.debit({ userId, currency: GOLD, amount, reason: CASINO_BET,
  idempotencyKey: 'casino-bet:{roundId}:{userId}:{item}', referenceType: 'casino_round',
  referenceId: roundId, metadata: { gameCode, item } })`. Insufficient balance → `casino_error`.
  Persist a `CasinoBet` row (`status = PLACED`, `betTxnId`).
- **Win (server-funded credit at settle):** `wallet.credit({ userId, currency: GOLD,
  amount: betAmount × effectiveMultiplier, reason: CASINO_WIN,
  idempotencyKey: 'casino-win:{roundId}:{betId}', referenceType: 'casino_round',
  referenceId: roundId })`. This is **not** bounded by any pot — it is the house paying out.
- **Settlement is one atomic transaction** (`repo.runInTransaction`, wallet locks pre-acquired):
  select all `PLACED` bets for the round → for each compute win/loss + payout → credit winners →
  update each `CasinoBet` (`WON`/`LOST`, `payoutAmount`, `winTxnId`) → close `CasinoRound`
  (`status = SETTLED`, `winningOutcome`, `settledAt`). If the transaction throws, **refund** all
  bets for the round (`wallet.credit` reason `CASINO_REFUND`, idempotent) and mark the round
  `ABORTED`. (Fixes the old crash-leaves-bets-unsettled hole.)
- **Ledger for both games** via the wallet's append-only `WalletTransaction` rows (idempotency keys
  above). Normalizes the old Greedy-only ledger behavior.
- **Per-user payout summation is correct** for multi-bet winners (fixes the old Greedy overwrite bug).

### 5.6 Persistence (new Prisma models — `prisma/schema/games.prisma` or a new `casino.prisma`)
```prisma
enum CasinoGame { GREEDY_FOOD LUCKY_FRUIT }
enum CasinoRoundStatus { BETTING SPINNING SETTLED ABORTED }
enum CasinoBetStatus { PLACED WON LOST REFUNDED }

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
  @@index([userId, status])
  @@index([roundId])
  @@map("casino_bets")
}
```
**Win history is derived** from `CasinoBet` (`userId` + `status = WON`, ordered by `createdAt` desc),
so no separate table is needed. `+ WalletTxnReason` gains `CASINO_BET/CASINO_WIN/CASINO_REFUND`.
`GameCode` gains `GREEDY_FOOD`, `LUCKY_FRUIT` (leave the dead `GREEDY` value untouched).
One new Prisma migration file — **not auto-applied**.

### 5.7 Inbound socket gateway (`/casino`)
`CasinoGateway extends BaseGateway` (namespace `/casino`), JWT-authed via `manager.authMiddleware()`.
Handlers (`@SubscribeMessage`), payloads and broadcasts reproduce the old event names verbatim:

**Client → server:**
| Event | Payload | Action |
|-------|---------|--------|
| `join_greedy_food` | — | join `greedy_food_global`, reply `greedy_food_sync` |
| `place_casino_bet` | `{ roundId, item, amount }` | validate (phase=betting, roundId matches, chip whitelist, item valid, balance), debit, persist, ack `bet_placed_success`, broadcast `greedy_food_pool_update` |
| `get_greedy_food_win_history` | — | reply `greedy_food_win_history` |
| `leave_greedy_food` | — | leave room |
| `join_lucky_fruit` | — | join `lucky_fruit_global`, reply `lucky_fruit_sync` |
| `place_lucky_fruit_bet` | `{ roundId, symbol, amount }` | validate (phase, roundId, chip whitelist, symbol bettable, ≤6 distinct symbols, balance), debit, persist, ack `lucky_fruit_bet_placed`, broadcast `lucky_fruit_pool_update` |
| `get_lucky_fruit_win_history` | — | reply `lucky_fruit_win_history` |
| `leave_lucky_fruit` | — | leave room |

**Server → client (per game):**
- Greedy: `greedy_food_sync`, `greedy_food_tick`, `greedy_food_new_round`, `greedy_food_spin`,
  `greedy_food_results`, `greedy_food_pool_update`, `bet_placed_success`, `greedy_food_win_history`.
- Lucky: `lucky_fruit_sync`, `lucky_fruit_tick`, `lucky_fruit_result`, `lucky_fruit_settlement`,
  `lucky_fruit_pool_update` (pool map emitted directly), `lucky_fruit_bet_placed`, `lucky_fruit_win_history`.
- Shared error: `casino_error { message }`.

Payload shapes match the old exactly (see the old socket files + Flutter listeners). Notably:
`*_results`/`*_settlement` include `winners:[{username,amount}]` (top 3) and `payouts:{ "<userId>": amount }`
so a client can self-credit instantly; sync includes `myBets`, `pool/poolBets`, `history`, `balance`,
`onlineCount`, `secondsRemaining`, `phase`.

---

## 6. Frontend design (`soulzaa-mobile`, `lib/features/casino/`)

Riverpod v3 + pixel-identical ported rendering. Reuse the shared shell atoms where visually identical;
port the old HUD painters verbatim for everything distinctive.

### 6.1 Feature layout
```
lib/features/casino/
  data/casino_socket_service.dart            # connects /casino namespace, emit/on wrappers
  domain/entities/casino_enums.dart          # GreedyFoodItem, LuckyFruitSymbol, phase
  domain/entities/casino_round_state.dart    # immutable state consumed by the UI
  presentation/controllers/greedy_food_controller.dart   # Notifier; socket → state
  presentation/controllers/lucky_fruit_controller.dart
  presentation/screens/greedy_food_screen.dart           # Flame wheel table (ported HUD)
  presentation/screens/lucky_fruit_screen.dart           # 4×5 grid table (ported HUD)
  presentation/screens/greedy_food_win_history_screen.dart
  presentation/screens/lucky_fruit_win_history_screen.dart
  presentation/widgets/...                    # ported painters: wheel, food/fruit icons, chips, results card
```

### 6.2 Controllers (Riverpod `Notifier`)
- `GreedyFoodController` / `LuckyFruitController` mirror the old `GreedyFoodGame` / `LuckyFruitGame`
  state fields (phase, secondsRemaining, onlineCount, playerBalance, activeRoundId, pool, myBets,
  resultsHistory, lastWinners, winningOutcome, spin trigger, win history).
- Wire to the `/casino` socket via `CasinoSocketService`, registering handlers for every server event
  and emitting the client events. Balance sourced from `walletSummaryProvider.gold` on entry; mirrored
  back to the wallet after each settlement (like the old `syncCoinBalance`).
- Chip set `[100,500,1000,10000,50000]`; selected chip in state.

### 6.3 UI — port verbatim
- **Greedy Food:** Flame `GameWidget` rendering the spinning wheel (10 slices, gold ring, 24 chase
  bulbs, red pointer), spin physics (`AnimationController` 10s, `Curves.easeOutQuart`, 10 full turns,
  land winning slice under the top pin), tap-a-slice to bet, gold bet pill per slice. Chrome: header
  (gold gradient title, ROUND pill, online pill, sound toggle), gold timer banner (PLACE YOUR
  BETS/SPINNING.../RESULT), history strip (8 dots), 5 poker chips, wallet/action bar (LOCK BETS
  INSTANTLY + REPEAT), results card. Procedural `CustomPaint` food icons ported from
  `greedy_food_icons.dart`. Scaffold bg `0xFF120826`, stage radial + ambient glows per old.
- **Lucky Fruit:** pure-Flutter 4×5 grid (14 perimeter cells + "45x" center panel), chase-light
  reveal walk (`spinTrigger` → `_triggerChaseAnimation`), tap-a-cell to bet, gold bet badge per cell.
  Same header/timer/history/chips/action-bar chrome (label "BETS LOCK INSTANTLY"). Procedural fruit
  icons ported from `lucky_fruit_icons.dart`. Scaffold bg `0xFF0F031A`, purple/orange glows per old.
- **Both:** shared menu popup (How to Play, Win History, Top Winners, Live Wins, Sound, Vibration,
  Leave), results card (width 300, gold border), `GoogleFonts.outfit`, gold coin glyph, `casino_error`
  red SnackBar. Reuse `GameBackground`/`GlassPill`/`GameCoin`/`showGameMenu`/`GameCountdown` only where
  the result is visually identical to the old; otherwise port the old widget.
- Results card + win totals read the **frozen** `lastRoundResult` snapshot captured at settlement
  (the post-round re-sync clears live bets) — replicate this or winnings render as 0.

### 6.4 Win history
Port both win-history screens (3-stat summary: TOTAL WINS / TOTAL WON / BIGGEST + card list), fed by
`get_*_win_history` → `*_win_history` socket events.

### 6.5 Entry & routing
- Add `GameCode.greedyFood`, `GameCode.luckyFruit` (Flutter enum, `api` = `GREEDY_FOOD`/`LUCKY_FRUIT`,
  `.name` matching `GamePosterArt.fromName`). Run `dart run build_runner build` for codegen.
- Games dashboard: casino codes render as cards (poster already wired). Tap handler special-cases
  casino → `context.push('/casino/greedy_food' | '/casino/lucky_fruit')` (new routes), full-screen,
  portrait, `PopScope` confirm-leave. No mode sheet, no offline path.

---

## 7. Faithfulness fixes (the only intentional deviations — all money-safety)

1. Lucky Fruit settlement made **atomic** (was per-bet; a crash mid-settle left bets unsettled).
2. **Refund-on-settlement-failure** for both games (old had none — coins could be lost).
3. **Wallet ledger rows for both** games (old wrote them for Greedy only).
4. Greedy multi-bet **payout/leaderboard summation** corrected (old overwrote per user).
5. Lucky Fruit bet **validates `roundId`** against the active round (old only checked phase).

Everything else — item sets, multipliers, bonus semantics, timings, chip values, UI — is exact.

---

## 8. Testing strategy

- **Pure engine specs:** liability selection (incl. zero-bet uniform, tie-break, house-min property),
  multiplier + bonus math for every item/outcome pair, chip whitelist, Lucky ≤6-symbol cap,
  Greedy salad-bonus and Lucky small/big-lucky payouts.
- **Service specs** (Jest, hand-rolled mocks like `games.service.spec.ts`): real-time GOLD debit with
  wallet lock, insufficient-balance rejection, idempotent bet/win keys, atomic settlement, refund path
  on transaction failure, correct per-user summation, ledger writes for both games.
- **Flutter widget tests:** both tables render, chip selection, bet placement emits the right event,
  results card reads the frozen snapshot, win-history list.
- **Gates before "done":** backend `lint` + `tsc` + `build` green; `dart analyze` clean; all tests pass.

---

## 9. Rollout & what an unattended "process" run does

**Will do:** implement the backend `casino` module + gateway + engines + service + repo + migration
**file**; add wallet reasons + GameCode values + catalog seed; implement the Flutter `casino` feature
(both tables, win history, entry); write tests; run lint/tsc/build + `dart analyze` and report actual
output.

**Will NOT do:** any git command; auto-apply the DB migration (hand over the exact
`prisma migrate` command to run); on-device visual/gameplay QA; live end-to-end socket betting against
a running server + device.

**Manual close-out (flagged for the user):**
1. Apply the migration (`npx prisma migrate dev --name casino_greedy_lucky` or the deploy equivalent).
2. On-device check that both tables look/feel identical to the old app.
3. Live gold-coin bet → win/loss end-to-end on a running server + device.

---

## 10. Risks / watch-items

- **Liability engine is house-always-wins.** This is intended per decision #1 but is a real
  gambling-fairness posture; keep it configurable-friendly in code even though the live default is fixed.
- **Leader-lock correctness** is the crux of multi-instance safety; the round's active bets must be
  reconstructable from `CasinoBet` rows so a failover doesn't drop or double-settle a round.
- **Socket namespace/auth** must match how the Flutter app authenticates other namespaces (JWT in
  handshake); confirm the exact handshake field during implementation.
- **Pixel fidelity** depends on faithfully porting the two large HUD files + icon painters; re-read
  them at implementation time rather than working from this summary.
