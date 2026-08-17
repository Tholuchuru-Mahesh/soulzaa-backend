/**
 * Read models for the agency Member Profile screen's five endpoints.
 *
 * The same rule as `agency-dashboard.interface.ts` applies throughout: a value
 * the platform cannot answer is `null`, never `0`. The mobile client renders
 * `null` as a muted em dash rather than inventing a figure.
 */
import type { GradeBand, ScoreInputs } from '../constants/member-score.constants';

/** One member's place in their agency's engagement ranking. */
export interface MemberScore {
  userId: string;
  /** 0-100. */
  score: number;
  rank: number;
  totalMembers: number;
  /** Null when the agency is too small for a percentile to mean anything. */
  topPercent: number | null;
  grade: GradeBand;
  /** The raw figures the score was built from, so a caller can show its parts. */
  inputs: ScoreInputs;
}

/** A whole-number figure alongside its period-over-period change. */
export interface MemberMetricDelta {
  value: number;
  /**
   * Null when the baseline window was zero — a change from nothing is not a
   * percentage, and both `∞%` and `100%` would be wrong.
   */
  changePercent: number | null;
  comparedTo: 'LAST_MONTH';
}

/** The same, for a coin figure — BigInt, so the value is a string. */
export interface MemberCoinMetricDelta {
  value: string;
  changePercent: number | null;
  comparedTo: 'LAST_MONTH';
}

export type TimelineKind =
  'LOGIN' | 'GIFT_SENT' | 'GIFT_RECEIVED' | 'ROOM_JOINED' | 'VIDEO_ROOM_JOINED' | 'EVENT_JOINED';

export interface MemberTimelineEntry {
  id: string;
  kind: TimelineKind;
  title: string;
  detail: string | null;
  occurredAt: Date;
}

export interface MemberActivityCounters {
  totalActivities: number;
  loginDays: number;
  giftsSent: number;
  giftsReceived: number;
  roomsJoined: number;
  eventsJoined: number;
}

export type PerformanceRange = 'week' | 'month' | 'quarter';

export interface MemberChartPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Rolling 7-day engagement score, 0-100. */
  value: number;
}

export interface MemberDetailMetric {
  key: 'ENGAGEMENT_RATE' | 'VIDEO_ROOM' | 'AUDIO_ROOM' | 'DAYS_ACTIVE';
  label: string;
  /** 0-100. */
  percent: number;
  changePercent: number | null;
}
