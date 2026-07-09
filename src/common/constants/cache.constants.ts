/** Cache TTL tiers (seconds) — used with CacheService.set / getOrSet. */
export const CACHE_TTL = {
  SHORT: 60,
  MEDIUM: 300,
  LONG: 3600,
  DAY: 86_400,
} as const;

/** Cache key prefixes so keys are collision-free and discoverable. */
export const CACHE_KEYS = {
  USER: 'user:',
  WALLET: 'wallet:',
  ROOM: 'room:',
  RANKING: 'ranking:',
  SESSION: 'session:',
  PRIVACY: 'privacy:',
} as const;
