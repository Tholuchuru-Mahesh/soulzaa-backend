# Games Module Migration — Mapping & Phased Roadmap

> **For agentic workers:** This is the master mapping + roadmap. Each PHASE below is turned into
> its own bite-sized, TDD, task-by-task plan (`.../plans/2026-07-15-games-phaseN-*.md`) at the
> time that phase starts, using superpowers:writing-plans. Do NOT implement from this doc directly —
> implement from a phase plan.

**Goal:** Bring the OLD apps' Games module (6 games) into the NEW apps by filling the seams of the
Games *platform* that already exists in both, preserving player-visible gameplay while adopting the
new platform's transport (`/games` namespace) and hardened, escrow-bounded settlement.

**Strategy (locked by user):**
1. **Conform to the new platform** — port gameplay into existing seams; adopt the `/games` contract.
   Gameplay (games, rules, timers, stakes, wheels, animations) preserved; transport + money-trust
   become the new platform's.
2. **Escrow-bounded board payouts** — platform escrows every stake, pays the host-reported winner but
   never more than the pot. The platform's existing `settleResult` anti-cheat (`sum(payouts) ≤ pot`,
   winners must be participants) already enforces this.

**Sources of truth (read-only):**
- OLD backend: `/Users/lt611-18/Soulzaa_new_backend-1` (Node/Socket.IO). Games logic in
  `controller/socket_controllers/{game_socket,greedy_food_socket,lucky_fruit_socket,free_wallet_socket}.js`.
- OLD frontend: `/Users/lt611-18/Soulzaa_new_2026-1` (Flutter/provider). `lib/core/games/**` +
  `lib/presentation/screens/main_screens/main_screen_pages/games/**`.
- NEW backend: `/Users/lt611-18/soulzaa-backend` (NestJS/Prisma). `src/modules/games/**`.
- NEW frontend: `/Users/lt611-18/soulzaa-mobile` (Flutter/Riverpod). `lib/features/games/**`.

Detailed per-codebase analyses were produced in the session scratchpad (`analysis/01..04`).

---

## Global Constraints (apply to every task)

- **No duplicate modules/services/repos/controllers/DTOs/providers/models** — extend what exists.
- **No new JS files in the new backend.** TypeScript + NestJS DI only. Avoid `any` where practical
  (repo's lint has `no-explicit-any` OFF, but follow existing typed style).
- **Cross-module access only via `interfaces/` tokens or `events/` / EVENT_BUS** (dependency-cruiser
  enforced; run `pnpm boundaries`). Games settles coins ONLY through `@Inject(WALLET_SERVICE)`.
- **Backend money:** every wallet movement uses a deterministic `idempotencyKey`
  (`game-stake|payout|refund:${sessionId}:${userId}`), mirrored into `game_transactions`. Reasons
  `GAME_STAKE/GAME_PAYOUT/GAME_REFUND` already exist.
- **Backend realtime:** publish a `DomainEvent` → subscribe in `game-socket.listener.ts` → emit via
  `SocketManager`. Inbound client events only via a `@SubscribeMessage` on `GamesGateway`
  (a `BaseGateway` subclass) — the ONLY sanctioned place.
- **Frontend:** Riverpod manual providers; reuse `SocketManager` (`socketManagerProvider`),
  `DioClient`, `GoRouter`, `AppTheme`, core widgets, `home` wallet providers. Board rendering ports
  into the relevant `games/<code>/<code>_plugin.dart` `buildSession`. No second socket stack.
- **Preserve exactly (behavior):** seat indices never spliced from a started match (forfeit sets a
  `hasLeft` flag); `isOver` latch (a decided match can't be re-decided); the `send_game_move` turn
  whitelist + `nextTurnPlayerId`/`noTurnChange` precedence; emote id-only wire + rate limits; casino
  lowest-liability outcome engine (that IS the house edge — do NOT "make it fair").

---

## 1. The two paradigms (handle separately)

| | Board games (LUDO, CARROM, UNO, DOMINO) | Casino (Greedy Food, Lucky Fruit) |
|---|---|---|
| Old model | Client-authoritative peer relay; server = room + move relay + reconnect; **host reports winner** | Server-authoritative continuous 24/7 house-wheel; server picks lowest-liability outcome |
| Players | 2–4, host + joiners, per-match rooms | Unlimited, no host, one shared global round |
| Money (old) | `free_coins`, client-directed `free_wallet_*`, idempotent by `matchId` | `balance` (gold), `SELECT FOR UPDATE`, per-round settle |
| Currency (new) | CASUAL / **FREE** | PREMIUM / **GOLD** |
| Fit to new platform | **Clean** — lobby→session→settleResult already models this | **Poor** — lobby/session match model can't represent a continuous shared round |
| New GameCode | LUDO, CARROM, UNO, DOMINO (exist, 1:1) | GREEDY exists but re-designed by new team; Lucky Fruit has **no** code (ambiguous) |

**Consequence:** Board games are a high-value, low-risk "fill the seam" migration. Casino is a
separate round-engine sub-system that also needs a product decision (see §6). **Do board games first.**

---

## 2. Backend: what the platform ALREADY gives us vs what must be BUILT

**Already built (reuse, do not duplicate):**
- Catalog (`GameDefinition` + seeder), lobby create/join/leave/start, session create, **escrow on
  start** (`wallet.debit` GAME_STAKE per participant, pot fixed), **`settleResult`** (validates +
  `wallet.credit` GAME_PAYOUT to winners, caps at pot), **cancel/refund** (GAME_REFUND), expiry
  monitor, history, leaderboard (Redis sorted sets), `game_transactions` ledger, `game_match_results`,
  `game_event_logs`, `/games` namespace + `GamesGateway`, `GameSocketListener`, error codes
  (`GAME_*`), HTTP controllers (`games`, `admin/games`), Jest spec pattern.
- Socket events (server→client): `game.lobby_created|joined|left|cancelled`, `game.started`,
  `game.settled`, `game.cancelled`.

**Must be BUILT into the seams (board games):**
1. **In-session move relay.** Inbound `@SubscribeMessage('game:move')` on `GamesGateway` → validate
   sender is a session participant & not forfeited → apply turn-rotation bookkeeping (old whitelist) →
   publish `GameMoveEvent` → `game-socket.listener` fans out `game.move_received` to the session room.
   (Old `send_game_move`→`game_move_received`.)
2. **In-session emotes.** Inbound `game:emote` (id-only, allowlist, rate-limited 1.5s/5-per-10s) →
   fan out `game.emote_received` to room **except sender**. (Old `send_game_emote`.)
3. **In-match forfeit + reconnect state-restore.** Disconnect grace (60s player / 45s host), forfeit
   sets participant `hasLeft`/status without removing the seat; on reconnect emit a state-restore frame
   (room + ordered move log + current turn + remaining seconds). Needs a lightweight in-session live
   store (Redis, keyed by session) for the move log + turn pointer + seat presence, since Postgres
   holds only the settled record. (Old `player_disconnected/reconnected/forfeited`, `game_state_restore`.)
4. **Host-reported settlement bridge.** On old `game_over` (winner + reason), the host client calls a
   session-result endpoint/event; the platform computes pot-share payout (solo winner takes pot; 2v2
   team splits) and calls `settleResult`. This is where **escrow-bounded** lives — payouts are derived
   from the escrowed pot, never from a client-sent amount.
5. **2v2 team model + `set_player_team`, matchmaking, `add_bot`, `kick_player`, `close_room`,
   `update_room_settings`** — extend the lobby model to carry team + bot seats + private/password +
   matchmaking queue. (Old lobby-management events.)

**Must be BUILT (casino) — see §6 for the open decision:**
6. A **casino round-engine** (a `*.monitor.ts`-style scheduler) running continuous betting→spinning→
   results phases per casino game, lowest-liability outcome pick, per-round settle via
   `wallet.debit/credit` (GOLD) + `game_transactions`, new persistence for rounds/bets (a
   `casino_rounds`/`casino_bets` analog added to `games.prisma`), and its own socket events. This does
   NOT use the lobby/session tables.

---

## 3. Backend file mapping (old → new)

| Old (JS) | Behavior | New (NestJS/TS) — extend these |
|---|---|---|
| `game_socket.js` room mgmt (create/join/ready/start/settings/kick/close) | lobby lifecycle | `services/games.service.ts` (extend lobby methods: teams, bots, private/password, matchmaking), `dto/games.dto.ts`, `repositories/games.repository.ts`, `games.prisma` (lobby: team/bot/private cols) |
| `game_socket.js` `send_game_move` relay + turn rotation | in-session relay | NEW: `GamesGateway` `@SubscribeMessage('game:move')`; `services/game-session-relay.service.ts` (new, turn whitelist + live store); `events/game.events.ts` (+`GameMoveEvent`); `listeners/game-socket.listener.ts` (+`game.move_received`); `constants/games.constants.ts` (+event name, +Redis live-session keys) |
| `game_socket.js` emotes/report | in-session emote + report | NEW `game:emote` handler + `game.emote_received`; report → reuse existing report/moderation seam if present, else `game_event_logs` |
| `game_socket.js` disconnect/forfeit/reconnect + `game_state_restore` | grace + restore | NEW: extend `game-expiry.monitor.ts` or add `game-presence.monitor.ts`; live store in Redis; `game.player_disconnected|reconnected|forfeited`, `game.state_restore` events |
| `game_socket.js` `game_over` → winner | settlement trigger | Host-reported result → `settleResult` (existing). Add a `POST games/sessions/:id/report-result` (non-admin, host-only, pot-derived) OR a `game:result` inbound event; compute payouts server-side from pot |
| `free_wallet_socket.js` (`free_wallet_bet/settle/refund` on `free_coins`) | board money | **Replaced** by platform escrow/settle/refund on WalletCurrency.FREE (already built). No `free_wallet_*` events in new app. |
| `greedy_food_socket.js` / `lucky_fruit_socket.js` (round loop, lowest-liability, settle) | casino | NEW casino round-engine (§2.6, §6); `games.prisma` (+casino round/bet models, new migration); new socket events mirroring old `greedy_food_*` / `lucky_fruit_*` semantics on `/games` |
| MySQL `user_wallets.free_coins` / `.balance` | dual balance | WalletCurrency FREE / GOLD (already in wallet module) |
| MySQL `casino_rounds` / `casino_bets` | casino persistence | NEW Prisma models under `games.prisma` |
| MySQL `free_coin_transactions` | board ledger | `game_transactions` (STAKE/PAYOUT/REFUND) — already built |
| MySQL `game_player_reports` | reports | `game_event_logs` or existing moderation module |

---

## 4. Frontend file mapping (old → new)

The new frontend platform (catalog, lobbies, sessions, matchmaking, history, leaderboard, socket
controllers) is complete. Migration = implement each game's board in its plugin `buildSession`, add the
board-game realtime layer the platform's receive-only controllers don't yet have, and add casino HUDs.

| Old (Flutter, `lib/core/games` + `.../games/`) | New (`lib/features/games/**`) — extend these |
|---|---|
| `providers/game_provider.dart` (ChangeNotifier, board room/moves/emotes) | Reuse `game_session_controller.dart` + `lobby_controller.dart` (Riverpod, already socket-driven); extend their state for moves/turn/emotes/restore. Do NOT port ChangeNotifier. |
| `multiplayer/game_socket_manager.dart` | Reuse `SocketManager` + extend `game_session_controller` subscriptions; add inbound emits (`game:move`, `game:emote`, `game:result`) |
| `models/game_room_model.dart` (`GameType/GameRoom/GamePlayer/GameMove`) | Reuse `domain/entities/*` (game_enums, game_session, game_participant); add a `GameMove`/move-frame entity + parsers in `game_signal_events.dart` |
| `ludo/ludo_state.dart` (REAL engine, 534 LOC) + `ludo/ludo_board_painter.dart` (796) + `ludo_screen.dart` (1538) | `games/ludo/ludo_plugin.dart` `buildSession` → new `games/ludo/` board widget(s) porting `ludo_state` + painter. (`engine/ludo_game.dart` is DEAD — do not port.) |
| `engine/carrom_game.dart` (2095, Flame physics) | `games/carrom/carrom_plugin.dart` `buildSession` → port Flame engine (add `flame` dep) |
| `engine/uno_game.dart` + `uno_core.dart` | `games/uno/uno_plugin.dart` (disabled in old; lower priority) |
| `engine/dominoes_game.dart` + core + ai | `games/domino/domino_plugin.dart` (disabled in old; lower priority) |
| `engine/greedy_food_game.dart` + core + icons + `greedy_food_hud_overlay.dart` | `games/greedy/greedy_plugin.dart` + HUD (casino phase) |
| `engine/lucky_fruit_game.dart` + core + icons + `lucky_fruit_hud_overlay.dart` | casino plugin (code TBD — §6) |
| `widgets/{game_design,game_theme,game_coin,quick_chat,how_to_play,game_menu,...}` | Port needed in-match widgets under `features/games/presentation/widgets/` (reuse core theme/widgets; don't duplicate loaders/buttons) |
| `game_poster_art.dart` + 4 poster PNGs | `GameMetadata` seam already provides icon/accent; add `assets/games/` posters + wire in `pubspec.yaml` if desired |
| Free/gold wallet providers | Reuse `home` `walletSummaryProvider` / `getWalletBalanceUseCaseProvider` (already wired in games) |

---

## 5. Socket contract mapping (old default `/` → new `/games`)

Board games (client→server unless noted). Old event → new event on `/games`:

| Old | New |
|---|---|
| `create_game_room`/`join_game_room`/`get_game_room_info` | REST lobby create/join + `room:join` (existing) |
| `set_player_team`/`toggle_ready`/`start_game`/`update_room_settings`/`kick_player`/`close_game_room`/`add_bot` | REST lobby endpoints (extend existing) |
| `join_matchmaking`/`cancel_matchmaking` | matchmaking controller/state (frontend exists) + backend queue (build) |
| `send_game_move` → `game_move_received` | `game:move` (inbound) → `game.move_received` (out) |
| `send_game_emote` → `game_emote_received` | `game:emote` → `game.emote_received` (room except sender) |
| `report_player` → `report_ack` | reuse moderation seam / `game_event_logs` |
| `game_room_updated`/`game_started`/`game_room_closed` | `game.lobby_*`/`game.started`/`game.cancelled` (exist) |
| `player_disconnected|reconnected|forfeited`, `game_state_restore` | `game.player_disconnected|reconnected|forfeited`, `game.state_restore` (build) |
| `game_over` (in moveData) | host-reported result → `settleResult` → `game.settled` (exists) |
| `free_wallet_*` | removed (platform escrow/settle/refund) |
| `greedy_food_*` / `lucky_fruit_*` / `place_casino_bet` / `place_lucky_fruit_bet` | casino round-engine events on `/games` (build; preserve semantics incl. naming asymmetries) |

---

## 6. OPEN DECISION — casino mapping & scope

The old casino games don't fit the platform's match model AND their `GameCode` mapping is ambiguous:
- Old **Greedy Food** (house-wheel) vs new **GREEDY** (scaffolded as a 2–8p lobby stake game) — same
  name, different design. Does old Greedy Food *replace* the new GREEDY definition, or coexist?
- Old **Lucky Fruit** has **no** `GameCode`. Options: add a new `LUCKY_FRUIT` code; reuse `ROULETTE`
  (also a wheel, but fruit-specific multipliers make the name a misnomer); or defer.
- New **ROULETTE/SLOTS/JACKPOT** have no old implementation (out of migration scope; they're new games
  the new team planned).

**Recommendation:** Do board games first (clean, high value). Resolve casino mapping with product
before building the casino round-engine. Default proposal if forced: old Greedy Food → redefine
`GREEDY` as the house-wheel; old Lucky Fruit → new `LUCKY_FRUIT` code (most faithful).

---

## 7. Phased roadmap

Each phase produces working, testable software and gets its own detailed TDD plan when it starts.

- **Phase 0 — Foundation & contract (backend).** Extend `games.prisma` (team/bot/private on lobby;
  in-session live-store keys), add board-game socket event names + `GameMoveEvent`/emote/presence
  events, add the `GamesGateway` inbound handlers (`game:move`, `game:emote`, `game:result`) as
  no-op-validated skeletons, wire the listener fan-out. Unit-spec the relay/turn-whitelist logic.
- **Phase 1 — Ludo end-to-end (the flagship enabled game).** Backend: move relay + host-reported
  escrow-bounded settlement + forfeit/reconnect restore for a real match. Frontend: implement
  `ludo_plugin.buildSession` porting `ludo_state.dart` + board painter + turn timer + win dialog into
  the Riverpod `game_session_controller`. Prove a full 2-player Ludo match settles coins correctly.
- **Phase 2 — Carrom.** Port the Flame physics engine into `carrom_plugin`; reuse Phase-0/1 relay.
- **Phase 3 — Matchmaking + 2v2 + bots + emotes polish** across board games.
- **Phase 4 — UNO + Domino** (old-disabled; enable per product).
- **Phase 5 — Casino round-engine** (after §6 decision): Greedy Food (+ Lucky Fruit), HUDs, win history.
- **Phase 6 — Cleanup & verification:** remove any temporary migration code, `pnpm boundaries`, full
  test + typecheck, end-to-end verification per game, confirm no duplicate files/JS.

**Dependencies:** Phase 0 gates 1–4. §6 decision gates 5. Frontend per-game work can start once its
game's backend relay/settlement contract from Phase 0/1 is fixed.

---

## 8. Top risks carried from the old system (preserve/decide, don't silently "fix")

- Board games have **no server-side win authority** — we replace client-trusted `free_wallet_settle`
  with **escrow-bounded host-reported** settlement (payout derived from pot, capped). This is the one
  deliberate behavior change the user approved.
- Casino **lowest-liability outcome engine is the entire house edge** — reproduce `selectWinningOutcome`
  exactly (incl. random tie-break); do not introduce fair RNG.
- Old Lucky Fruit settled from in-memory bets (lost on restart) and wrote no ledger — the new
  DB-backed round-engine + `game_transactions` fixes this inherently; note the divergence.
- Seat-index stability, `isOver` latch, turn whitelist, emote id-only + rate limits — reproduce exactly.
