import { GameCategory, GameCode, GameCurrency } from '@prisma/client';

/** Realtime namespace for game lobby/session fan-out. */
export const GAMES_NAMESPACE = '/games';

/** Socket event names emitted to a lobby/session room on the /games namespace. */
export const GAME_SOCKET_EVENTS = {
  LOBBY_CREATED: 'game.lobby_created',
  LOBBY_JOINED: 'game.lobby_joined',
  LOBBY_LEFT: 'game.lobby_left',
  LOBBY_CANCELLED: 'game.lobby_cancelled',
  STARTED: 'game.started',
  SETTLED: 'game.settled',
  CANCELLED: 'game.cancelled',
  /** A board-game move relayed to every socket in the session room. */
  MOVE_RECEIVED: 'game.move_received',
  /** A participant forfeited/left; clients withdraw the seat. */
  PLAYER_FORFEITED: 'game.player_forfeited',
  /** Matchmaking paired the user — a ready-check has opened (per-user fan-out). */
  MATCH_FOUND: 'game.match_found',
  /** A matched player readied up; carries who is still pending. */
  MATCH_READY_PROGRESS: 'game.match_ready_progress',
  /** A ready-check dissolved (timeout/decline/operational); some may be re-queued. */
  MATCH_CANCELLED: 'game.match_cancelled',
  /** A player's team changed in a TEAM_2V2 lobby (lobby-room fan-out). */
  LOBBY_TEAM_CHANGED: 'game.lobby_team_changed',
  /** The host kicked a member (lobby room + the kicked user). */
  LOBBY_MEMBER_KICKED: 'game.lobby_member_kicked',
} as const;

/** Bumped when a matchmaking socket payload shape changes (clients gate on it). */
export const MATCHMAKING_PROTOCOL_VERSION = 1;

/** Redis key holding a board session's live state (move log + turn pointer). */
export const gameLiveStateKey = (sessionId: string): string => `game:live:${sessionId}`;

/** How long a board session's live state survives idle (covers a full match). */
export const GAME_LIVE_STATE_TTL_SECONDS = 60 * 60;

/** Per-turn clock (advisory — clients drive the timeout, as in the legacy backend). */
export const GAME_TURN_SECONDS = 30;

/** Redis lock keys — hash-tagged so a lobby and its derived session share a slot. */
export const gameLobbyLockKey = (lobbyId: string): string => `game:lock:lobby:{${lobbyId}}`;
export const gameSessionLockKey = (sessionId: string): string => `game:lock:session:{${sessionId}}`;

/** Global leaderboards (Redis sorted sets). */
export const GAME_WINS_LEADERBOARD_KEY = 'game:wins';
export const gameWinningsLeaderboardKey = (currency: GameCurrency): string =>
  `game:winnings:${currency}`;

/** Lobby lifetime before an unstarted lobby auto-expires. */
export const GAME_LOBBY_TTL_MS = 15 * 60 * 1000;

/** Expiry monitor cadence + its distributed-lock key. */
export const GAME_MONITOR_LOCK_KEY = 'game:monitor';
export const GAME_MONITOR_INTERVAL_MS = 5_000;

/** Join-code generation (unambiguous uppercase alphabet, no O/0/I/1). */
export const GAME_JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const GAME_JOIN_CODE_LENGTH = 6;

// ======================= Matchmaking (Redis-ephemeral) =======================

/** Bucket ZSET (member=userId, score=queuedAt ms) — one per game+stake+matchType. */
export const gameMatchQueueKey = (gameCode: string, stake: number | bigint, matchType: string) =>
  `game:mmq:${gameCode}:${stake}:${matchType}`;
/** Per-user pointer JSON {bucketKey, retries, firstQueuedAt} — dedupe + O(1) leave. */
export const gameMatchUserKey = (userId: string) => `game:mmuser:${userId}`;
/** Ready-check state blob (JSON) for one proposed match. */
export const gameMatchReadyKey = (matchId: string) => `game:mmready:${matchId}`;
/** Index ZSET (member=matchId, score=expiresAt) — sweep due ready-checks without SCAN. */
export const GAME_MATCH_READY_INDEX_KEY = 'game:mmready:index';
/** Set of active bucket keys — lets the stale-entry sweep enumerate buckets without SCAN. */
export const GAME_MATCH_BUCKET_INDEX_KEY = 'game:mmq:index';
/** Per-user pointer → the matchId whose ready-check they're in (prevents double-match). */
export const gameMatchReadyUserKey = (userId: string) => `game:mmready:user:${userId}`;
/** Lock serializing match formation for one bucket (derived from the bucket key). */
export const gameMatchBucketLockKey = (bucketKey: string) => `game:lock:${bucketKey}`;
/** Lock serializing accept/dissolve for one ready-check. */
export const gameMatchReadyLockKey = (matchId: string) => `game:lock:mmready:${matchId}`;

/** Read a positive integer env override, else the fallback (explicit Number() coercion). */
function envPositiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

/** Ready-check window before a match dissolves (env: GAMES_MATCH_READY_SECONDS). */
export const matchReadySeconds = (): number => envPositiveInt('GAMES_MATCH_READY_SECONDS', 15);
/** Stale queue-entry TTL — pruned by the monitor (env: GAMES_MATCH_QUEUE_TTL_SECONDS). */
export const matchQueueTtlSeconds = (): number =>
  envPositiveInt('GAMES_MATCH_QUEUE_TTL_SECONDS', 120);
/** Max times a consenting player is re-queued after a dissolve (env: GAMES_MATCH_MAX_RETRIES). */
export const matchMaxRetries = (): number => envPositiveInt('GAMES_MATCH_MAX_RETRIES', 3);
/** Matchmaking master switch — set GAMES_MATCHMAKING_DISABLED=true to pause the queue. */
export const matchmakingEnabled = (): boolean => process.env.GAMES_MATCHMAKING_DISABLED !== 'true';

/**
 * Games whose engines actually implement 2v2 today — the gate for TEAM_2V2 lobbies
 * and matchmaking. Seat count alone is insufficient (Carrom seats up to 4 in the
 * catalog but its engine is 2-player-only). Add a game here once its client engine
 * genuinely supports the positional {0,2}/{1,3} team split.
 */
export const TEAM_2V2_CAPABLE_GAMES: ReadonlySet<GameCode> = new Set([GameCode.LUDO]);

/** Immutable per-game catalog defaults (PRD Vol.3 §16 currency mapping). */
export interface GameCatalogSeed {
  code: GameCode;
  name: string;
  category: GameCategory;
  currency: GameCurrency;
  minPlayers: number;
  maxPlayers: number;
  minStake: number;
  maxStake: number;
}

export const GAME_CATALOG_SEED: readonly GameCatalogSeed[] = [
  // Premium games — Gold Coins.
  {
    code: GameCode.GREEDY,
    name: 'Greedy',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 2,
    maxPlayers: 8,
    minStake: 100,
    maxStake: 1_000_000,
  },
  {
    code: GameCode.ROULETTE,
    name: 'Roulette',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 1,
    maxPlayers: 8,
    minStake: 100,
    maxStake: 1_000_000,
  },
  {
    code: GameCode.SLOTS,
    name: 'Slots',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 1,
    maxPlayers: 1,
    minStake: 100,
    maxStake: 1_000_000,
  },
  {
    code: GameCode.JACKPOT,
    name: 'Jackpot',
    category: GameCategory.PREMIUM,
    currency: GameCurrency.GOLD,
    minPlayers: 2,
    maxPlayers: 50,
    minStake: 100,
    maxStake: 1_000_000,
  },
  // Casual games — Free Coins.
  {
    code: GameCode.UNO,
    name: 'UNO',
    category: GameCategory.CASUAL,
    currency: GameCurrency.FREE,
    minPlayers: 2,
    maxPlayers: 4,
    minStake: 10,
    maxStake: 100_000,
  },
  {
    code: GameCode.LUDO,
    name: 'Ludo',
    category: GameCategory.CASUAL,
    currency: GameCurrency.FREE,
    minPlayers: 2,
    maxPlayers: 4,
    minStake: 10,
    maxStake: 100_000,
  },
  {
    code: GameCode.CARROM,
    name: 'Carrom',
    category: GameCategory.CASUAL,
    currency: GameCurrency.FREE,
    minPlayers: 2,
    maxPlayers: 4,
    minStake: 10,
    maxStake: 100_000,
  },
  {
    code: GameCode.DOMINO,
    name: 'Domino',
    category: GameCategory.CASUAL,
    currency: GameCurrency.FREE,
    minPlayers: 2,
    maxPlayers: 4,
    minStake: 10,
    maxStake: 100_000,
  },
];
