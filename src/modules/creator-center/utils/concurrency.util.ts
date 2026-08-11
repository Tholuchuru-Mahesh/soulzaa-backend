/**
 * Peak concurrent occupancy over a window, from a list of join/leave
 * intervals (each clamped into the window before sweeping). Standard
 * interval-sweep: +1 at each clamped start, -1 at each clamped end, sorted by
 * time (leaves before joins on an exact tie, so a same-instant handoff never
 * double-counts), tracking the running maximum.
 */
export function peakConcurrent(
  intervals: { joinedAt: Date; leftAt: Date | null }[],
  windowStart: Date,
  windowEnd: Date,
): number {
  const points: { t: number; delta: 1 | -1 }[] = [];
  for (const { joinedAt, leftAt } of intervals) {
    const start = joinedAt < windowStart ? windowStart : joinedAt;
    const end = leftAt && leftAt < windowEnd ? leftAt : windowEnd;
    if (start >= end) continue;
    points.push({ t: start.getTime(), delta: 1 });
    points.push({ t: end.getTime(), delta: -1 });
  }
  points.sort((a, b) => a.t - b.t || a.delta - b.delta);

  let current = 0;
  let peak = 0;
  for (const p of points) {
    current += p.delta;
    if (current > peak) peak = current;
  }
  return peak;
}
