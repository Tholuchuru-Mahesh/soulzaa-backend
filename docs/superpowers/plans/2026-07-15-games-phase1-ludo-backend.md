# Phase 1 (Milestone A) — Ludo Backend Foundation

> Implements the board-game backend seam for the Ludo end-to-end slice. TDD, tests green + typecheck
> is the review checkpoint. Master context: `2026-07-15-games-module-migration.md`. Milestone B (Ludo
> Flutter plugin) follows after review.

**Goal:** Extend the existing games platform so a real board match can relay moves in-session and settle
via a host-reported, pot-derived (escrow-bounded) result — reproducing the old `send_game_move` relay,
turn-rotation whitelist, `game_over`→settlement, and `game_state_restore`, on the `/games` contract.

## Global constraints
Inherit the master plan's Global Constraints. Money moves only through the existing `settleResult`
(never a client-sent amount). No infra→module imports (moves go through REST, not the gateway).

## Tasks (each: RED → verify fail → GREEN → verify pass)

- [ ] **T1 — Pure live-state engine** `services/game-live-state.ts` (+ `.spec.ts`).
  Types `GameLiveState`, `GameMoveFrame`; `initLiveState(seatOrder, startedAtMs, turnSeconds)`;
  `applyMove(state, frame)`. Reproduce old turn logic exactly: whitelist
  `{sync_state,shoot,aim,roll_dice,move_token,play_card,draw_card}` = client owns turn (no server
  rotation); `nextTurnPlayerId` truthy overrides; `noTurnChange` suppresses; otherwise rotate to next
  seat; `game_over` latches `isOver`; `sync_state` replaces the move log; `aim` not stored; others append.

- [ ] **T2 — Error code** add `GAME_NOT_PARTICIPANT` to `error-codes.ts`.

- [ ] **T3 — Constants** `games.constants.ts`: `GAME_SOCKET_EVENTS.MOVE_RECEIVED='game.move_received'`,
  `gameLiveStateKey(sessionId)`, `GAME_LIVE_STATE_TTL_SECONDS`, `GAME_TURN_SECONDS=30`.

- [ ] **T4 — Event** `game.events.ts`: `GAME_EVENTS.MOVE='game.move'` + `GameMoveEvent` payload
  `{sessionId, roomId, playerId, moveData, timestamp, currentTurnUserId}`.

- [ ] **T5 — Listener** `game-socket.listener.ts`: subscribe `GAME_EVENTS.MOVE` →
  `emitToNamespaceRoom('/games', sessionId, MOVE_RECEIVED, payload)`.

- [ ] **T6 — Service.relayMove** (+ spec): active session + participant + PLAYING guard; under session
  lock, load-or-init live state, `applyMove`, persist to cache; publish `GameMoveEvent`. Reject
  non-participant (`GAME_NOT_PARTICIPANT`) / non-active (`GAME_SESSION_NOT_ACTIVE`).

- [ ] **T7 — Service.reportMatchResult** (+ spec): host-only (`GAME_NOT_HOST`), active session; compute
  pot-derived payouts (honor `houseRakeBps`, even split with deterministic remainder), delegate to
  `settleResult(settledBy: host)`. Escrow-bounded falls out of `settleResult`'s existing checks.

- [ ] **T8 — Service.getLiveState** (+ spec): load-or-init; return `{currentTurnUserId,
  turnRemainingSeconds, isOver, moves}`.

- [ ] **T9 — DTOs** `SubmitMoveDto{moveData}`, `ReportMatchResultDto{winners, resultData?}`.

- [ ] **T10 — Controller** `POST sessions/:id/moves`, `POST sessions/:id/report-result`,
  `GET sessions/:id/live` (all `@NotGuest()` except the GET).

- [ ] **T11 — Verify** `pnpm test src/modules/games`, `pnpm typecheck`/build, `pnpm boundaries`.

## Deferred to later phases (NOT in this milestone)
Emotes, disconnect-grace forfeit + auto-settle, matchmaking, 2v2 teams/bots, private/password lobbies,
Carrom aim socket-streaming. Noted so scope stays tight.
