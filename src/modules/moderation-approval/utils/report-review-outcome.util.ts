/**
 * Audio-room, video-room and live-stream report review all tag a recommended
 * action with the same audit-trail string, and all fold a review's turnaround
 * time into the moderator's performance stats the same way. Shared here
 * instead of reimplemented per domain. (The WARNING/MUTE/KICK dispatch itself
 * stays per-domain — it calls genuinely different methods with different
 * signatures in each service, so there's nothing safe to unify there.)
 */

/** `[Report #<id> review] <resolution, or a default "Report action: X" note>` */
export function buildReportReviewReason(
  reportId: string,
  resolution: string | null | undefined,
  recommendedAction: string,
): string {
  return `[Report #${reportId} review] ${resolution ?? `Report action: ${recommendedAction}`}`;
}

export async function recordReportResolutionIfConfigured(
  performanceStats:
    | { recordReportResolution(actorId: string, resolutionMinutes: number): Promise<void> }
    | undefined,
  actorId: string,
  reportCreatedAt: Date,
): Promise<void> {
  if (!performanceStats) return;
  const resolutionMinutes = (Date.now() - reportCreatedAt.getTime()) / 60_000;
  await performanceStats.recordReportResolution(actorId, resolutionMinutes);
}
