import { VideoRoomReportReason } from '@prisma/client';
import { cooldownKey } from '../constants/video-room-moderation.constants';
import type {
  DetectionResult,
  ModerationDetector,
  ModerationSignal,
} from './detectors/moderation-detector.interface';
import { VideoRoomAutoModerationService } from './video-room-auto-moderation.service';

const CFG = {
  spamThreshold: 5,
  spamWindowSec: 60,
  floodThreshold: 10,
  floodWindowSec: 10,
  duplicateWindowSec: 30,
  rapidJoinLeaveThreshold: 5,
  rapidJoinLeaveWindowSec: 60,
  excessiveReportsThreshold: 5,
  excessiveReportsWindowSec: 300,
  warningThreshold: 3,
  autoMuteMinutes: 15,
  autoActionCooldownSec: 30,
  expiryMonitorIntervalMs: 15000,
  reasonMax: 200,
  descriptionMax: 1000,
};

const MESSAGE: ModerationSignal = {
  type: 'message',
  roomId: 'r1',
  userId: 'u1',
  contentHash: 'h1',
  spamFlagged: true,
};
const REPORT: ModerationSignal = { type: 'report', roomId: 'r1', targetUserId: 'u2' };

/** A stub detector that yields a fixed result (or null). */
const stub = (kind: string, result: DetectionResult | null): ModerationDetector => ({
  kind,
  evaluate: jest.fn().mockResolvedValue(result),
});

describe('VideoRoomAutoModerationService', () => {
  let redis: { set: jest.Mock };
  let config: { get: jest.Mock };
  let moderation: { autoMute: jest.Mock; autoKick: jest.Mock; autoFlag: jest.Mock };

  const build = (detectors: ModerationDetector[]) => {
    const [a, b, c, d, e] = detectors;
    return new VideoRoomAutoModerationService(
      redis as never,
      config as never,
      moderation as never,
      a as never,
      b as never,
      c as never,
      d as never,
      e as never,
    );
  };

  beforeEach(() => {
    redis = { set: jest.fn().mockResolvedValue('OK') };
    config = { get: jest.fn().mockReturnValue({ moderation: CFG }) };
    moderation = {
      autoMute: jest.fn().mockResolvedValue(undefined),
      autoKick: jest.fn().mockResolvedValue(undefined),
      autoFlag: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('reads thresholds only from config.get("videoRoom").moderation', async () => {
    const subject = build([
      stub('spam', { action: 'auto_mute', reason: 'spammy' }),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', null),
    ]);
    await subject.handle(MESSAGE);
    expect(config.get).toHaveBeenCalledWith('videoRoom');
    expect((subject as never as { detectors: ModerationDetector[] }).detectors).toBeDefined();
  });

  it('does nothing when no detector fires (no cooldown set, no auto action)', async () => {
    const subject = build([
      stub('spam', null),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', null),
    ]);
    await subject.handle(MESSAGE);
    expect(redis.set).not.toHaveBeenCalled();
    expect(moderation.autoMute).not.toHaveBeenCalled();
    expect(moderation.autoKick).not.toHaveBeenCalled();
    expect(moderation.autoFlag).not.toHaveBeenCalled();
  });

  it('takes the first non-null detection in evaluation order', async () => {
    const spam = stub('spam', null);
    const flood = stub('flood', { action: 'auto_mute', reason: 'flooding' });
    const dup = stub('duplicate', { action: 'auto_mute', reason: 'dup' });
    const subject = build([spam, flood, dup, stub('r', null), stub('e', null)]);
    await subject.handle(MESSAGE);
    // dup should never be consulted once flood fires.
    expect(dup.evaluate).not.toHaveBeenCalled();
    expect(moderation.autoMute).toHaveBeenCalledTimes(1);
  });

  it('maps auto_mute → moderation.autoMute with the message sender + meta.detector', async () => {
    const subject = build([
      stub('spam', { action: 'auto_mute', reason: 'spammy' }),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', null),
    ]);
    await subject.handle(MESSAGE);
    expect(moderation.autoMute).toHaveBeenCalledWith('r1', 'u1', 'spammy', { detector: 'spam' });
  });

  it('maps auto_kick → moderation.autoKick', async () => {
    const subject = build([
      stub('spam', null),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', { action: 'auto_kick', reason: 'churn' }),
      stub('excessive-reports', null),
    ]);
    await subject.handle({ type: 'join_leave', roomId: 'r1', userId: 'u1' });
    expect(moderation.autoKick).toHaveBeenCalledWith('r1', 'u1', 'churn', {
      detector: 'rapid-join-leave',
    });
  });

  it('maps auto_flag → moderation.autoFlag against the REPORT target with the enum reason', async () => {
    const subject = build([
      stub('spam', null),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', {
        action: 'auto_flag',
        reason: 'too many reports',
        meta: { reportReason: VideoRoomReportReason.ABUSE },
      }),
    ]);
    await subject.handle(REPORT);
    expect(moderation.autoFlag).toHaveBeenCalledWith(
      'r1',
      'u2',
      VideoRoomReportReason.ABUSE,
      expect.objectContaining({ detector: 'excessive-reports' }),
    );
  });

  it('defaults auto_flag reason to ABUSE when the detector omits one', async () => {
    const subject = build([
      stub('spam', null),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', { action: 'auto_flag', reason: 'flagged' }),
    ]);
    await subject.handle(REPORT);
    expect(moderation.autoFlag).toHaveBeenCalledWith(
      'r1',
      'u2',
      VideoRoomReportReason.ABUSE,
      expect.anything(),
    );
  });

  it('acquires the per-subject cooldown atomically (SET NX PX) before acting', async () => {
    const subject = build([
      stub('spam', { action: 'auto_mute', reason: 'spammy' }),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', null),
    ]);
    await subject.handle(MESSAGE);
    expect(redis.set).toHaveBeenCalledWith(cooldownKey('r1', 'u1'), 'spam', 'PX', 30_000, 'NX');
  });

  it('suppresses a second action while the subject is cooling down', async () => {
    const subject = build([
      stub('spam', { action: 'auto_mute', reason: 'spammy' }),
      stub('flood', null),
      stub('duplicate', null),
      stub('rapid-join-leave', null),
      stub('excessive-reports', null),
    ]);
    // First acquires the cooldown, second fails to (SET NX → null).
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    await subject.handle(MESSAGE);
    await subject.handle(MESSAGE);

    expect(moderation.autoMute).toHaveBeenCalledTimes(1);
  });
});
