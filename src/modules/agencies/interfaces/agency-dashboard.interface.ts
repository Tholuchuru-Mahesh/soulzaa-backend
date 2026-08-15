/**
 * Read models for the agency-owner dashboard (`GET /agencies/me/dashboard`).
 *
 * A metric this platform cannot answer yet is typed `null`, never `0`. The two
 * mean different things: an agency with no assigned tasks and an agency on a
 * platform with no task system are different facts, and only `null` states the
 * second honestly. The mobile client renders `null` as a muted em dash rather
 * than inventing a number.
 */

/** A community figure alongside its period-over-period change. */
export interface MetricDelta {
  value: number;
  /**
   * Percentage change against the same-length window one period earlier,
   * rounded to one decimal. Null when that baseline was zero — a change from
   * nothing is not a percentage, and both `∞%` and `100%` would be wrong.
   */
  changePercent: number | null;
  comparedTo: 'YESTERDAY' | 'LAST_MONTH';
}

export interface CommunityOverview {
  totalUsers: MetricDelta;
  dailyActive: MetricDelta;
  monthlyActive: MetricDelta;
  /** Members whose relationship began inside the last 30 days. */
  newMembers: MetricDelta;
}

/** How far back the growth chart looks. */
export type GrowthRange = 'week' | 'month' | 'quarter';

export interface GrowthPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Active members on that day. */
  value: number;
}

export interface GrowthSeries {
  range: GrowthRange;
  points: GrowthPoint[];
}

export interface TopPerformer {
  rank: number;
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** Coins as a string — BigInt loses precision past 2^53 as a JSON number. */
  points: string;
}

export interface AgencyDashboardView {
  agency: {
    displayName: string | null;
    avatarUrl: string | null;
  };
  wallet: {
    /** Coins as a string, for the same BigInt precision reason as above. */
    coins: string;
  };
  coinSeller: {
    active: boolean;
    /** Null when the caller holds no coin-seller inventory row. */
    availableBalance: string | null;
  };
  community: CommunityOverview;

  // ── Metrics with no source on this platform yet ──────────────────────────
  // Each becomes a real type the day the feature behind it ships; until then
  // the endpoint says "unknown" rather than "zero".
  /** No agency target is stored anywhere yet. */
  target: null;
  /** No performance-scoring formula exists yet. */
  performance: null;
  /** No agency-scoped tasks, events, achievements or support tickets exist. */
  operations: null;
  /** No agency reward inventory exists yet. */
  rewardInventory: null;
  /** Nothing assigns tasks to an agency yet. */
  assignedTasks: null;

  growth: GrowthSeries;
  topPerformers: TopPerformer[];
}
