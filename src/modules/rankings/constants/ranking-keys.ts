/**
 * Generic leaderboard key shape, shared by every ranking namespace.
 *
 *   <namespace>:{<scope>|<dimension>}:<period>:<dateKey>
 *
 * The Redis Cluster hash tag is deliberately `scope|dimension`, NOT the whole
 * key and NOT the scope alone. Every multi-key command this engine issues —
 * ZUNIONSTORE (quarterly from 3 monthlies) and RENAME (atomic replace) — stays
 * within one scope+dimension across dateKeys, so co-locating on that pair is
 * exactly enough to keep them Cluster-safe. Tagging on the scope alone would
 * collapse every global ladder onto a single slot; tagging more narrowly would
 * scatter the union sources across slots and make derivation impossible.
 */
export interface LeaderboardKeyParts {
  /** Root namespace, e.g. 'vrank'. Keeps engines from colliding. */
  namespace: string;
  /** Ranking universe: 'g' | 'r:<roomId>' | 'c:<ISO2>' | 'y:<cityId>'. */
  scope: string;
  /** What is being ranked: 'hosts' | 'gifters' | ... */
  dimension: string;
  period: string;
  dateKey: string;
}

export function buildLeaderboardKey(parts: LeaderboardKeyParts): string {
  const { namespace, scope, dimension, period, dateKey } = parts;
  return `${namespace}:{${scope}|${dimension}}:${period}:${dateKey}`;
}

/** The `{scope|dimension}` hash tag alone — for version counters and temp keys. */
export function leaderboardTag(scope: string, dimension: string): string {
  return `{${scope}|${dimension}}`;
}
