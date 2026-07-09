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
} as const;

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
