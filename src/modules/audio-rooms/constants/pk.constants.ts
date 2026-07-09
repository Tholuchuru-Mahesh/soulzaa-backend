/**
 * AR-10 PK-battle constants: locks serialising battle start + score/complete,
 * the expiry-sweep lock/interval, and the global PK-wins leaderboard key.
 */

/** Lock guarding a battle's score application + completion. */
export function pkBattleLockKey(battleId: string): string {
  return `pk:battle:${battleId}`;
}

/** Lock guarding "start a battle for a room". */
export function pkRoomLockKey(roomId: string): string {
  return `pk:room:{${roomId}}`;
}

/** Lock guarding the fleet-wide PK expiry sweep. */
export const PK_MONITOR_LOCK_KEY = 'pk:monitor';

/** How often the PK expiry monitor completes timed-out battles. */
export const PK_MONITOR_INTERVAL_MS = 3_000;

/** Global PK wins leaderboard (member = userId, score = wins). */
export const PK_WINS_LEADERBOARD_KEY = 'pk:wins';

/** Name of the winner-badge cosmetic (ensured in the catalog on demand). */
export const PK_WINNER_BADGE_NAME = 'PK Champion';

/** Bounds for team sizes. */
export const PK_MAX_TEAM_SIZE = 10;
