import type { VideoRoomReportReason } from '@prisma/client';

/**
 * VR-16 auto-moderation detector contract.
 *
 * A detector is a pluggable, self-contained rule that inspects a single
 * `ModerationSignal` and — if its rule fires — recommends one enforcement
 * action. Detectors are **stateless w.r.t. instance fields**: every rolling
 * window lives in Redis (keyed by the Task-2 counter/cooldown key builders),
 * so a detector holds only its injected dependencies and stays hot-swappable /
 * AI-ready. Thresholds and windows are read exclusively from
 * `config.get('videoRoom').moderation` and handed in as `cfg` — nothing here is
 * hardcoded.
 */

/** The enforcement action a detector recommends; maps 1:1 to a `VideoRoomModerationService.auto*` method. */
export type AutoModerationAction = 'auto_mute' | 'auto_kick' | 'auto_flag';

/**
 * A discriminated signal fed into the auto-moderation engine. `message`
 * carries the chat layer's own spam verdict (`spamFlagged`) so detectors can
 * reconcile with — rather than re-run — upstream scanning. `contentHash` is
 * OPTIONAL: it is only a hash of the actual message text, never a stand-in
 * for something else (e.g. a spam-kind enum). A source that cannot supply a
 * real content hash (the chat `SPAM_DETECTED` event carries no message text)
 * must omit it entirely rather than feed the duplicate detector a
 * low-cardinality proxy — see `DuplicateDetector`, which treats an absent
 * `contentHash` as "not applicable" rather than a comparable value.
 */
export type ModerationSignal =
  | {
      type: 'message';
      roomId: string;
      userId: string;
      contentHash?: string;
      spamFlagged: boolean;
    }
  | { type: 'join_leave'; roomId: string; userId: string }
  | { type: 'report'; roomId: string; targetUserId: string };

/** The `type` discriminant of a `ModerationSignal`. */
export type ModerationSignalType = ModerationSignal['type'];

/**
 * A positive detection: what to do, a human-readable reason for the audit
 * trail, and optional detector metadata. An `auto_flag` result may carry a
 * `reportReason` (the Prisma enum) so the engine can open the system report
 * with the right category; it defaults to `ABUSE` when absent.
 */
export interface DetectionResult {
  action: AutoModerationAction;
  reason: string;
  meta?: Record<string, unknown> & { reportReason?: VideoRoomReportReason };
}

/**
 * The moderation config slice every detector (and the engine) reads its
 * thresholds/windows/cooldown from — the exact shape of
 * `config.get('videoRoom').moderation` (see `config/configuration.ts`, Task 3).
 */
export interface ModerationDetectorConfig {
  spamThreshold: number;
  spamWindowSec: number;
  floodThreshold: number;
  floodWindowSec: number;
  duplicateWindowSec: number;
  rapidJoinLeaveThreshold: number;
  rapidJoinLeaveWindowSec: number;
  excessiveReportsThreshold: number;
  excessiveReportsWindowSec: number;
  warningThreshold: number;
  autoMuteMinutes: number;
  autoActionCooldownSec: number;
  expiryMonitorIntervalMs: number;
  reasonMax: number;
  descriptionMax: number;
}

/**
 * A pluggable automated-moderation rule. `evaluate` returns a `DetectionResult`
 * when the rule fires for this signal, or `null` when the signal doesn't apply
 * to this detector or is still under threshold. `kind` labels the detector on
 * the audit metadata (`meta.detector`) and the `video_rooms_moderation_auto_actions_total`
 * metric.
 */
export interface ModerationDetector {
  readonly kind: string;
  evaluate(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<DetectionResult | null>;
}
