/**
 * The engagement model behind the member profile's score, grade and rank.
 *
 * Everything tunable lives here rather than inside a query, so the model can
 * be retuned against real platform volumes without touching Prisma code. The
 * weights sum to 1, which is what bounds the score to 0-100 without a clamp.
 */

/** The rolling window every headline figure is measured over. */
export const SCORE_WINDOW_DAYS = 30;

/**
 * Below this, a percentile is noise: in a 3-member agency, second place is
 * "top 67%", which reads as an insult rather than a measurement.
 */
export const MIN_MEMBERS_FOR_PERCENTILE = 10;

export interface ScoreInputs {
  /** Distinct calendar days with a login. */
  loginDays: number;
  /** Audio + video room joins. */
  roomsJoined: number;
  giftsSent: number;
  giftsReceived: number;
}

export interface ScoreWeight {
  weight: number;
  /** The value at which this input contributes its full weight. */
  cap: number;
}

export const SCORE_WEIGHTS: Record<keyof ScoreInputs, ScoreWeight> = {
  loginDays: { weight: 0.3, cap: 30 },
  roomsJoined: { weight: 0.25, cap: 30 },
  giftsSent: { weight: 0.25, cap: 50 },
  giftsReceived: { weight: 0.2, cap: 50 },
};

export interface GradeBand {
  min: number;
  code: string;
  label: string;
  caption: string;
}

/** Ordered high to low: `gradeFor` returns the first band the score reaches. */
export const GRADE_BANDS: readonly GradeBand[] = [
  { min: 80, code: 'EXCELLENT', label: 'Excellent', caption: 'keep it up!' },
  { min: 60, code: 'GOOD', label: 'Good', caption: 'nearly there' },
  { min: 40, code: 'FAIR', label: 'Fair', caption: 'room to grow' },
  { min: 0, code: 'NEEDS_WORK', label: 'Needs work', caption: 'let us help' },
];

/**
 * The 0-100 engagement score for one member.
 *
 * [windowDays] scales every cap, so the chart's 7-day rolling points land on
 * the same axis as the 30-day headline figure and the two stay comparable.
 */
export function scoreMember(inputs: ScoreInputs, windowDays: number = SCORE_WINDOW_DAYS): number {
  const scale = windowDays / SCORE_WINDOW_DAYS;
  let total = 0;

  for (const key of Object.keys(SCORE_WEIGHTS) as (keyof ScoreInputs)[]) {
    const { weight, cap } = SCORE_WEIGHTS[key];
    const scaledCap = cap * scale;
    // A zero-length window has no cap to divide by; it contributes nothing
    // rather than producing NaN and poisoning the whole sum.
    const ratio = scaledCap <= 0 ? 0 : Math.min(inputs[key] / scaledCap, 1);
    total += weight * ratio;
  }

  return Math.round(total * 100);
}

export function gradeFor(score: number): GradeBand {
  return GRADE_BANDS.find((band) => score >= band.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
}

/**
 * "Top X%" for a member at [rank] of [totalMembers].
 *
 * Null below [MIN_MEMBERS_FOR_PERCENTILE]. Floored at 1 because rank 1 is
 * still a member of the population — "top 0%" would describe nobody.
 */
export function topPercentFor(rank: number, totalMembers: number): number | null {
  if (totalMembers < MIN_MEMBERS_FOR_PERCENTILE) return null;
  return Math.max(1, Math.ceil((rank / totalMembers) * 100));
}
