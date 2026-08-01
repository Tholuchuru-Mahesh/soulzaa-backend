/**
 * How long a dedupe claim survives, per producer.
 *
 * Each value is chosen from the natural lifetime of the *thing* being deduped,
 * not from a general-purpose default: the key only has to outlive the window in
 * which the same domain event could plausibly be redelivered.
 */
export const GUARD_TTL = {
  /** A wallet transaction id is unique forever; an hour covers any retry storm. */
  WALLET_TXN: 3600,
  /** A game session settles once. */
  GAME_SESSION: 3600,
  /**
   * A day. The VIP expiry sweep runs daily and would otherwise re-notify the
   * same user for every day of the expiry window.
   */
  VIP_WINDOW: 86_400,
  /** Token refresh can re-emit a login detection; five minutes absorbs it. */
  LOGIN: 300,
} as const;

export const GUARD_BUDGET = {
  /**
   * Per user, per category, per hour. Deliberately generous — this is a
   * backstop against a runaway producer, not a curation policy. A user who
   * legitimately receives 30 wallet notifications in an hour is doing something
   * unusual; a producer sending 3000 is broken.
   */
  PER_CATEGORY_PER_HOUR: 30,
  WINDOW_SECONDS: 3600,
} as const;
