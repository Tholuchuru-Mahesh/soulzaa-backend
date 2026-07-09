/** Wallet business constants (PRD Vol.3 — Coin Economy). */
export const MIN_WALLET_BALANCE = 0;

/** Treasure Box unlock costs by level (Gold Coins). */
export const TREASURE_BOX_COSTS = [15_000, 60_000, 200_000, 350_000] as const;

/** Example coin-package price points (INR); actual packages are Admin-configurable. */
export const COIN_PACKAGE_PRICES = [99, 199, 499, 999, 1999, 4999, 9999] as const;

/** Free Coins are only usable in these casual games. */
export const FREE_COIN_GAMES = ['UNO', 'LUDO', 'CARROM', 'DOMINO'] as const;
