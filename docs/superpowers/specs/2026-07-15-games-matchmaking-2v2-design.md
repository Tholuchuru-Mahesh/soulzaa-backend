# Games Phase 3 — Matchmaking Queue + 2v2 Teams

- **Status:** Approved (design) — ready for implementation
- **Date:** 2026-07-15
- **Module:** `src/modules/games` (backend), contract mirrored in `soulzaa-mobile` games feature
- **Related:** builds on the migrated Games platform (board games → lobby/session/settleResult)

## 1. Context & goals

The Games platform already owns lobbies (create/join/leave/start by code), entry-stake
escrow on start, a trusted settlement seam (`settleResult`) + host-reported settlement
(`reportMatchResult` → `splitPot`), forfeit, cancel, in-session peer-relay, leaderboards,
and history. Two Phase-3 capabilities are missing and are built together here because both
touch the lobby model:

1. **Matchmaking queue** — auto-pair strangers by `game + stake + matchType` (no join code),
   with an all-ready ready-check before any money moves.
2. **2v2 teams** — two teams of two, with manual team pick + auto-balance, wired to the
   engines that already implement 2v2 (Ludo, Carrom).

### Guiding constraints (from stakeholder direction)
- **Reuse, don't duplicate.** `startSessionFromLobby()` is the single path to session
  creation + escrow; `splitPot()` + `settleResult()` are the single settlement paths. No
  parallel implementations.
- **Redis-ephemeral matchmaking.** Queue + ready-check live in Redis, protected by the
  existing `LockService`; timeouts are swept by the existing `GameExpiryMonitor`. No BullMQ
  workers or SQL persistence for matchmaking unless a future production need demands it.
- **Escrow is the money boundary.** Nothing financial happens until all players are ready
  and `startSessionFromLobby()` runs, so pre-start state is safely throwaway.

## 2. Non-goals / out of scope
- Party / pre-made duo queue (solo-queue only; teams auto-balanced). Deferred (YAGNI).
- Private/password lobbies, kick/close, bots, presence auto-forfeit — separate Phase-3 slices.
- Casino/FFA-of-N matchmaking — matchmaking supports `DUEL` (2) and `TEAM_2V2` (4) only.
- Per-game 2v2 capability metadata — gated on `maxPlayers >= 4` for now; a
  `GameDefinition.config` flag can refine this later.

## 3. Key findings that shape the design (verified in code)
- **Teams are positional.** Ludo (`isSameTeam`) and Carrom hardcode Team A = seats **{0,2}**,
  Team B = seats **{1,3}**. "Assigning a team" = placing the player in the right seat.
- **Team-split settlement is ~90% present.** `splitPot()` already even-splits across
  `winners[]`. The 2v2 gap is *modeling* teams and *expanding* a winning-team report into its
  two members — not a new settlement path.
- **No matchmaking queue exists.** Frontend `quickMatch()` is client-side browse+join/create;
  the socket contract already declares the backend the sole source of truth for matchmaking.
- **Infra to reuse:** `GameExpiryMonitor` (setInterval + `LockService`) → ready-check/stale
  sweeps; `GameSocketListener` (DomainEvent→socket) → new matchmaking events;
  `SocketManager.emitToUserEverywhere` → reach a queuing user not yet in a room.

## 4. Decisions (resolved with stakeholder)
| Question | Decision |
|----------|----------|
| Queue → start | Auto-form lobby; **all-ready auto-start with timeout** (re-queue the ready, drop the rest) |
| Team assignment | **Manual `set_player_team` with auto-balance fallback** at start; validate 2-2 |
| Matchmaking infra | **Redis queue + synchronous match-on-enqueue + monitor sweep** |
| Settlement (2v2) | Host reports **winning team**; backend expands to both teammates → `splitPot` |
| Host / settlement authority (matched) | First-queued player (`players[0]`), fixed at ready-check open |

## 5. Data model (Prisma `prisma/schema/games.prisma`) — additive, backward-compatible

New enums:
```prisma
enum GameMode {
  CLASSIC    // 1..maxPlayers, no teams — existing behavior (default)
  TEAM_2V2   // exactly 4 players, two teams of two
}
enum GameTeam { A  B }
```
Column additions (all defaults preserve current behavior):
- `GameLobby`: `mode GameMode @default(CLASSIC)`, `isMatchmade Boolean @default(false)`
- `GameLobbyMember`: `team GameTeam?`
- `GameSession`: `mode GameMode @default(CLASSIC)`
- `GameParticipant`: `team GameTeam?`, `seat Int @default(0)`

**`seat` rationale:** 2v2 requires a deterministic `[A,B,A,B]` order (engines read Team A =
seats {0,2}). Today seat order derives from `participant.joinedAt`, which `createMany` does not
stably order. Setting `seat` explicitly and ordering `listParticipants` + `initLiveState` by
`seat asc` fixes 2v2 and removes a latent CLASSIC nondeterminism.

`isMatchmade` lobbies are excluded from the public browse (`listOpenLobbies`) — they are
transient, created only at finalize and started near-atomically.

Migration: additive columns with defaults → safe on existing rows (read as `CLASSIC` / `null`
/ `seat 0`). Reseed not required.

## 6. Matchmaking queue — Redis, synchronous match-on-enqueue

### Redis structures (new constants in `games.constants.ts`)
| Key | Type | Purpose |
|-----|------|---------|
| `game:mmq:{gameCode}:{stake}:{matchType}` | ZSET member=userId, score=queuedAt(ms) | bucket; FIFO by score, O(log n) removal |
| `game:mmuser:{userId}` | JSON `{bucketKey, retries, firstQueuedAt}` | dedupe + O(1) leave + retry tracking |
| `game:mmready:{matchId}` | JSON (ready-check state, §7) | one proposed match |
| `game:mmready:index` | ZSET member=matchId, score=expiresAt | timeout sweep without SCAN |
| `game:mmready:user:{userId}` | string → matchId | a user is in at most one ready-check |
| `game:lock:mmq:{gameCode}:{stake}:{matchType}` | LockService | serialize match formation per bucket |
| `game:lock:mmready:{matchId}` | LockService | serialize accept/dissolve per match |

`matchType ∈ {DUEL, TEAM_2V2}`; `requiredSize(DUEL) = 2`, `requiredSize(TEAM_2V2) = 4`.
**matchType → lobby mode mapping:** `DUEL` → a `CLASSIC` lobby of 2 (winner-take-pot);
`TEAM_2V2` → a `TEAM_2V2` lobby of 4. This is the only place matchType and mode differ in name.

### `joinQueue(actor, {gameCode, stake, matchType})`
1. Validate: game enabled, stake in range; `TEAM_2V2` ⇒ `def.maxPlayers >= 4` else
   `GAME_2V2_UNSUPPORTED`. Reject if matchmaking is disabled (maintenance flag) →
   `GAME_MATCHMAKING_DISABLED`.
2. Lightweight `assertCanAfford` (UX guard; escrow at start is authoritative).
3. Reject if already queued (`game:mmuser`) → `GAME_ALREADY_QUEUED`, or already in a
   ready-check (`game:mmready:user`) → `GAME_ALREADY_QUEUED`.
4. Under the bucket lock: `ZADD` (score=now), write the user pointer (`retries` carried across
   re-queues; new join starts at 0). Then `ZCARD`; if `>= requiredSize`, `ZPOPMIN` the earliest
   `requiredSize` users, clear their pointers, and **open a ready-check** (§7).
5. Emit telemetry `matchmaking.queued`. Return `{status:'QUEUED', matchType}` or
   `{status:'MATCHED', matchId}`.

### `leaveQueue(actor, reason='left')`
Read bucket from the pointer; under the bucket lock `ZREM` + clear pointer. Log
`matchmaking.queue_exit {reason, retries, waitedMs}` + telemetry. Return `{left:true}`.
Idempotent (not-queued → `{left:false}`, no throw).

### `getMatchmakingStatus(actor)` (reconnect/restore)
Returns the user's current `{state:'QUEUED', bucket…}` or `{state:'READY_CHECK', matchId,
players, ready, expiresAt}` or `{state:'IDLE'}` from Redis — lets a reconnecting client
re-render without a race.

## 7. Ready-check — all-ready-or-dissolve, monitor-swept timeout

### State `game:mmready:{matchId}` (Redis, TTL = readySeconds + buffer)
```
{ matchId,               // opaque public token (crypto-random; NOT a DB/lobby id)
  v,                     // MATCHMAKING_PROTOCOL_VERSION
  gameCode, stake, matchType, currency, mode,
  bucketKey,
  players: [uid...],     // ordered by queuedAt — players[0] = hostId (fixed here, persisted to lobby at finalize)
  ready:   [uid...],
  hostId,
  expiresAt }            // absolute ms — survives restart, client countdown stays valid
```
Plus `game:mmready:index` (ZSET score=expiresAt) and `game:mmready:user:{uid}` pointers.

**Timeouts are configurable** (`ConfigService`, `Number()`-coerced, env-overridable):
- `GAMES_MATCH_READY_SECONDS` (default 15)
- `GAMES_MATCH_QUEUE_TTL_SECONDS` (default 120) — stale-entry prune
- `GAMES_MATCH_MAX_RETRIES` (default 3) — re-queue cap

### Open ready-check
Generate opaque `matchId`; store state; `ZADD` index; set user pointers; emit **`game.match_found`**
to each player via `emitToUserEverywhere`:
```
{ v, matchId, gameCode, stake, matchType, players, readySeconds, expiresAt }
```
Emit telemetry `matchmaking.matched {gameCode, stake, matchType, waitedMsPerPlayer[], bucketDepth}`.
**Team composition is frozen at this point** — no team mutation is accepted during the
ready-check window.

### `acceptMatch(actor, matchId)` — under `game:lock:mmready:{matchId}`
- Load state; `GAME_MATCH_NOT_FOUND` if absent, `GAME_MATCH_EXPIRED` if past `expiresAt`;
  actor must be in `players`.
- Add actor to `ready[]` (set semantics → idempotent).
- **All ready** → `finalize`:
  1. `createLobby` with `mode` (from matchType), `hostId = state.hostId`, `isMatchmade = true`,
     members = `players` (teams unassigned for matchmaking; auto-balanced at start).
  2. `startSessionFromLobby(lobbyId, hostId)` — the existing escrow/pot/`GameStartedEvent` path,
     unchanged.
  3. Clear all matchmaking state (index, key, user pointers). Emit telemetry
     `matchmaking.ready_result {result:'all_ready', elapsedMs}`.
  - If escrow aborts (a player spent coins between queue and ready), the existing
    refund-all/abort runs; emit `game.match_cancelled {reason:'stake_failed'}`; no auto-re-queue.
- **Not yet** → save; emit **`game.match_ready_progress`** `{v, matchId, ready, remaining}`.

### `declineMatch(actor, matchId)` → immediate dissolve (same as timeout).

### Dissolve (timeout / decline / operational) — `dissolveReadyCheck(state, reason)`
- **Re-queue** everyone in `ready[]` (they consented) whose `retries + 1 <= MAX_RETRIES`,
  incrementing `retries`; those over the cap exit with reason `exhausted`
  (`game.match_cancelled {reason:'exhausted'}`).
- **Drop** everyone not in `ready[]` (the decliner + the slow), exit reason `dropped`.
- Emit **`game.match_cancelled`** `{v, matchId, reason, requeued:[uid...]}` to all players.
- `ZREM` index; delete state + user pointers. Log per-user `matchmaking.queue_exit`; telemetry
  `matchmaking.ready_result {result: reason, acceptedCount, declinedCount, elapsedMs}`.

### `MatchCancelReason`
`declined | timeout | exhausted | stake_failed | server_shutdown | redis_unavailable | maintenance`.

## 8. Session-start seam (no duplication)
Refactor `startLobby` into:
- `startLobby(actor, code)` (REST) → assert `hostId === actor.id` → delegate.
- **`startSessionFromLobby(lobbyId, hostId)`** — the current body of `startLobby` (min-players
  check, `createSession`, `createParticipants`, escrow loop with idempotency keys + refund-on-fail,
  pot, `markLobbyStarted`, `GameStartedEvent`, analytics). Matchmaking finalize calls this
  directly. This is the ONLY session-creation/escrow path.

For `TEAM_2V2`, `startSessionFromLobby` runs `assignTeamsAndSeats` (below) before
`createParticipants`, requires exactly 4 members, and persists each participant's `team`+`seat`.
CLASSIC sets `seat` = member join order, `team = null`.

## 9. 2v2 team assignment

### `setPlayerTeam(actor, code, team)`
- Lobby `status = OPEN` (else `GAME_LOBBY_NOT_OPEN` — this is the manual-lobby freeze) and
  `mode = TEAM_2V2` (else `GAME_NOT_TEAM_MODE`).
- Actor is a member; sets **their own** team; reject if that team already holds 2 → `GAME_TEAM_FULL`.
- Emit **`game.lobby_team_changed`** `{v, code, userId, team, teams:{A:[…],B:[…]}}` to the lobby room.

### Pure fn `assignTeamsAndSeats(members, picks) → [{userId, team, seat}]`
(in a new pure `matchmaking-core.ts`, unit-tested like `game-live-state.ts`):
- start from `picks` (from `GameLobbyMember.team`); fill unassigned into open slots (A then B)
  to reach 2-2;
- reject if any team > 2 → `GAME_TEAM_UNBALANCED` (race backstop);
- output seats `[A0, B0, A1, B1]` ⇒ positions {0,2}=A, {1,3}=B.

## 10. Settlement — team expansion (single authoritative path)
- **CLASSIC:** unchanged — `reportMatchResult(winners[])` → `splitPot` → `settleResult`.
- **TEAM_2V2:** `reportMatchResult` requires `winningTeam:'A'|'B'` (host reports the team, not
  ids). Backend expands to that team's two participants → `winners=[both]` → `splitPot`
  (distributable = pot − rake) splits 50/50 → `settleResult`. Prevents lopsided/incomplete
  team reports.
- **Trusted `settleResult` seam (admin) unchanged** — explicit `winners`/`payouts`.
- **2v2 forfeit:** mark the forfeiter `LOST`; regroup remaining `PLAYING` by team. If only one
  team retains any player → that team wins; `winners` = its **still-playing** members (a
  forfeiter forfeits their claim; a lone survivor takes the team's full share) → expand →
  `settleResult`. If both teams retain players → continue. CLASSIC forfeit unchanged.

## 11. REST + socket surface

### REST (all `@NotGuest()`, rate-limited — §12)
| Method | Path | Body | → service |
|--------|------|------|-----------|
| POST | `games/matchmaking/queue` | `{gameCode, stake, matchType}` | `joinQueue` |
| POST | `games/matchmaking/leave` | — | `leaveQueue` |
| GET | `games/matchmaking/status` | — | `getMatchmakingStatus` |
| POST | `games/matchmaking/:matchId/accept` | — | `acceptMatch` |
| POST | `games/matchmaking/:matchId/decline` | — | `declineMatch` |
| POST | `games/lobbies/:code/team` | `{team}` | `setPlayerTeam` |

- `CreateLobbyDto` += optional `mode` (default `CLASSIC`) — manual 2v2 lobbies.
- `ReportMatchResultDto` += optional `winningTeam` (required when session `mode = TEAM_2V2`).
- New DTOs: `JoinQueueDto {gameCode, stake, matchType}`, `SetPlayerTeamDto {team}`.
- `matchId` path param validated as an opaque token (not `ParseUuidPipe`).

### Socket (server→client) — protocol-versioned
New `GAME_SOCKET_EVENTS` + mirror in frontend `GamesSocketEvents`, bridged in
`GameSocketListener` via new DomainEvents. Every payload carries `v =
MATCHMAKING_PROTOCOL_VERSION` (= 1):
- `game.match_found`, `game.match_ready_progress`, `game.match_cancelled` → fan out via
  `emitToUserEverywhere` (queuing users aren't in a room).
- `game.lobby_team_changed` → lobby `code` room.
- `game.started` / `game.settled` reused (carry real lobby/session ids at finalize; ready-check
  payloads never leak internal ids).

New DomainEvents: `GameMatchFoundEvent`, `GameMatchReadyProgressEvent`, `GameMatchCancelledEvent`,
`GameLobbyTeamChangedEvent`.

### New error codes (append to `error-codes.ts`)
`GAME_ALREADY_QUEUED`, `GAME_NOT_QUEUED`, `GAME_MATCH_NOT_FOUND`, `GAME_MATCH_EXPIRED`,
`GAME_2V2_UNSUPPORTED`, `GAME_TEAM_FULL`, `GAME_TEAM_UNBALANCED`, `GAME_NOT_TEAM_MODE`,
`GAME_MATCHMAKING_DISABLED`.

## 12. Rate limits
Throttle every matchmaking endpoint using the app's existing limiter (custom/Redis-based —
confirm mechanism at wiring time; not `@nestjs/throttler`). Targets per user:
`queue` 10/min, `accept` 20/min, `decline` 20/min, `leave` 20/min, `team` 30/min. Prevents
queue-flapping and accept/decline spam.

## 13. Analytics / telemetry (fire-and-forget via `QueueService` → `ANALYTICS_PROCESSING`)
- `matchmaking.queued {gameCode, stake, matchType}`
- `matchmaking.matched {gameCode, stake, matchType, waitedMsPerPlayer[], bucketDepth}`
- `matchmaking.ready_result {matchType, result, acceptedCount, declinedCount, elapsedMs}`
- `matchmaking.queue_exit {gameCode, stake, matchType, reason, retries, waitedMs}`
Queue-performance metrics: time-in-queue, time-to-match, ready acceptance rate, fill rate,
bucket depth at match, retry distribution — all derivable from the above.

## 14. Server-restart & operational recovery
- Queue + ready-check are Redis-resident → survive an app restart. On boot,
  `GameExpiryMonitor` resumes; first ticks:
  1. `sweepExpiredReadyChecks(now)` — `ZRANGEBYSCORE game:mmready:index 0 now` → dissolve
     (reason `timeout`) anything expired during downtime. Live checks continue (absolute
     `expiresAt`; accepts resolve against Redis).
  2. `sweepStaleQueueEntries(now)` — per bucket `ZREMRANGEBYSCORE 0 (now − QUEUE_TTL)` +
     clear pointers; exit reason `stale`.
- **Graceful shutdown** (`OnModuleDestroy`): best-effort `drainMatchmaking()` dissolves live
  ready-checks with reason `server_shutdown` (re-queue the ready so another instance rematches).
- **Redis loss/failover:** matchmaking state is gone — acceptable (no money moved). A client
  accept then gets `GAME_MATCH_NOT_FOUND` and returns to the queue-entry UI. No SQL recovery.
- **Maintenance:** a config flag pauses `joinQueue` (`GAME_MATCHMAKING_DISABLED`); an admin
  drain dissolves live checks with reason `maintenance`.
- Disconnect cleanup: stale-TTL sweep is the guarantee; an optional subscription to the
  presence-offline event gives a fast-path `leaveQueue(reason:'disconnect')`.

## 15. Edge cases
- Double-queue / queue-while-in-ready-check → `GAME_ALREADY_QUEUED`.
- Accept twice → no-op; accept finalized/expired → `GAME_MATCH_EXPIRED`/`GAME_MATCH_NOT_FOUND`.
- Escrow fails at finalize → refund-all/abort + `game.match_cancelled{stake_failed}`.
- `TEAM_2V2` for a <4-seat game → `GAME_2V2_UNSUPPORTED` at queue/create.
- All mutations under the appropriate lock (bucket / ready-check / lobby / session).
- `setPlayerTeam` outside OPEN → `GAME_LOBBY_NOT_OPEN` (the manual-lobby team freeze).

## 16. Test plan
- **Pure unit** (`matchmaking-core.spec.ts`): `requiredSize`, bucket-key building,
  `assignTeamsAndSeats` (all-picked / partial / unbalanced / all-unassigned / seat order),
  settlement team-expansion.
- **Service** (`games.service.spec.ts` harness; mocked repo/cache/locks/wallet/queue):
  queue→match→all-ready→start happy path; timeout dissolve + re-queue with retry increment +
  exhaustion cap; decline; `setPlayerTeam` + auto-balance at start; 2v2 settlement expansion;
  2v2 forfeit branches; restart sweep reconciliation; escrow-fails-at-finalize.

## 17. Implementation map (files)
- `prisma/schema/games.prisma` — enums + columns (+ migration).
- `src/modules/games/constants/games.constants.ts` — Redis keys, `MATCHMAKING_PROTOCOL_VERSION`,
  config defaults, `requiredSize`.
- `src/modules/games/services/matchmaking-core.ts` (+ `.spec.ts`) — pure fns.
- `src/modules/games/services/games.service.ts` — `joinQueue`/`leaveQueue`/`getMatchmakingStatus`/
  `acceptMatch`/`declineMatch`/`dissolveReadyCheck`/`setPlayerTeam`/`startSessionFromLobby`
  refactor/2v2 settlement+forfeit/sweeps/drain.
- `src/modules/games/services/game-expiry.monitor.ts` — call the two new sweeps.
- `src/modules/games/repositories/games.repository.ts` — team/seat/mode writes, matchmade-filter
  in `listOpenLobbies`, `getLobbyMembersWithTeams`.
- `src/modules/games/dto/games.dto.ts` — `JoinQueueDto`, `SetPlayerTeamDto`, `CreateLobbyDto.mode`,
  `ReportMatchResultDto.winningTeam`.
- `src/modules/games/events/game.events.ts` — 4 new events.
- `src/modules/games/listeners/game-socket.listener.ts` — bridge the 4 events.
- `src/modules/games/controllers/games.controller.ts` — 6 endpoints + rate limits.
- `src/common/exceptions/error-codes.ts` — 9 new codes.
- Frontend (`soulzaa-mobile`): mirror socket events + `v`; queue/ready-check controller wiring
  (separate follow-on slice).

## 18. Open questions / future
- Duo/party queue (pre-made pairs) — deferred.
- Per-game 2v2 capability via `GameDefinition.config` — currently `maxPlayers >= 4`.
- Presence-offline fast-path `leaveQueue` — optional enhancement.
