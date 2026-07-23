import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoRoomReportReason } from '@prisma/client';
import { REDIS_CLIENT, RedisClient } from 'src/infra/redis/redis.constants';
import { cooldownKey } from '../constants/video-room-moderation.constants';
import { DuplicateDetector } from './detectors/duplicate.detector';
import { ExcessiveReportsDetector } from './detectors/excessive-reports.detector';
import { FloodDetector } from './detectors/flood.detector';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationDetectorConfig,
  ModerationSignal,
} from './detectors/moderation-detector.interface';
import { RapidJoinLeaveDetector } from './detectors/rapid-join-leave.detector';
import { SpamDetector } from './detectors/spam.detector';
import { VideoRoomModerationService } from './video-room-moderation.service';

/**
 * VR-16 Task 19 automated-moderation engine. Fans a `ModerationSignal` across
 * its pluggable detector chain, takes the first positive detection, gates it
 * through a per-subject cooldown, and delegates the enforcement to the
 * system-actor `VideoRoomModerationService.auto*` methods.
 *
 * Design invariants:
 *  - **Config-only thresholds.** Every window/threshold is read fresh from
 *    `config.get('videoRoom').moderation` and handed to the detectors as `cfg`;
 *    nothing is hardcoded here.
 *  - **Metrics ownership.** The `auto*` methods already increment
 *    `video_rooms_moderation_auto_actions_total` (labelled by `meta.detector`),
 *    so this engine passes `meta: { detector: kind }` and NEVER calls
 *    `metrics.incAutoAction` itself — that would double-count.
 *  - **Cooldown suppression.** The cooldown is claimed with an atomic
 *    `SET NX PX` (acquire-with-TTL) BEFORE acting, so a second signal for the
 *    same subject inside the window is a clean no-op even under concurrency —
 *    no check-then-act race.
 *  - **Stateless detectors.** All rolling state lives in Redis; detectors hold
 *    no mutable instance fields, keeping them hot-swappable / AI-ready.
 */
@Injectable()
export class VideoRoomAutoModerationService {
  /** Evaluation order = precedence when several detectors match one signal. */
  private readonly detectors: ModerationDetector[];

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
    private readonly moderation: VideoRoomModerationService,
    spam: SpamDetector,
    flood: FloodDetector,
    duplicate: DuplicateDetector,
    rapidJoinLeave: RapidJoinLeaveDetector,
    excessiveReports: ExcessiveReportsDetector,
  ) {
    this.detectors = [spam, flood, duplicate, rapidJoinLeave, excessiveReports];
  }

  /**
   * Evaluate a signal against every detector, act on the first positive
   * detection (once per cooldown window), and return. Detectors self-filter on
   * `signal.type`, so a signal only exercises the detectors that apply to it.
   */
  async handle(signal: ModerationSignal): Promise<void> {
    const cfg = this.moderationConfig();

    const fired = await this.firstDetection(signal, cfg);
    if (!fired) return;

    const subjectUserId = this.subjectOf(signal);

    // Atomic cooldown gate: acquire-with-TTL. A losing SET NX (key already
    // present) means the subject is cooling down → suppress this action.
    const acquired = await this.redis.set(
      cooldownKey(signal.roomId, subjectUserId),
      fired.detector.kind,
      'PX',
      cfg.autoActionCooldownSec * 1000,
      'NX',
    );
    if (acquired === null) return;

    await this.dispatch(signal.roomId, subjectUserId, fired.detector.kind, fired.result);
  }

  /** First detector to return a non-null result, with the detector that fired. */
  private async firstDetection(
    signal: ModerationSignal,
    cfg: ModerationDetectorConfig,
  ): Promise<{ detector: ModerationDetector; result: DetectionResult } | null> {
    for (const detector of this.detectors) {
      const result = await detector.evaluate(signal, cfg);
      if (result) return { detector, result };
    }
    return null;
  }

  /** Route a detection to the mapped system auto-action, tagging the detector. */
  private async dispatch(
    roomId: string,
    subjectUserId: string,
    kind: string,
    result: DetectionResult,
  ): Promise<void> {
    const meta = { detector: kind, ...(result.meta ?? {}) };
    switch (result.action) {
      case 'auto_mute':
        await this.moderation.autoMute(roomId, subjectUserId, result.reason, meta);
        break;
      case 'auto_kick':
        await this.moderation.autoKick(roomId, subjectUserId, result.reason, meta);
        break;
      case 'auto_flag':
        await this.moderation.autoFlag(roomId, subjectUserId, this.reportReasonOf(result), meta);
        break;
    }
  }

  /** The user a signal targets: the reported user for reports, else the actor. */
  private subjectOf(signal: ModerationSignal): string {
    return signal.type === 'report' ? signal.targetUserId : signal.userId;
  }

  /** `autoFlag` takes the Prisma enum; default to ABUSE when unspecified. */
  private reportReasonOf(result: DetectionResult): VideoRoomReportReason {
    return result.meta?.reportReason ?? VideoRoomReportReason.ABUSE;
  }

  /**
   * The `videoRoom.moderation` config slice, read fresh per call (no hardcoded
   * fallback) — mirrors `VideoRoomModerationService.autoMuteMinutes`'s
   * "throw if the namespace isn't registered" convention.
   */
  private moderationConfig(): ModerationDetectorConfig {
    const root = this.config.get<{ moderation?: ModerationDetectorConfig }>('videoRoom');
    if (!root?.moderation) {
      throw new Error('videoRoom.moderation config is not registered');
    }
    return root.moderation;
  }
}
