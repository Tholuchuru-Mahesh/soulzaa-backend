import { VideoRoomReportReason } from '@prisma/client';
import { reportCounterKey } from '../../constants/video-room-moderation.constants';
import type { ModerationDetectorConfig, ModerationSignal } from './moderation-detector.interface';
import { ExcessiveReportsDetector } from './excessive-reports.detector';

const CFG = {
  excessiveReportsThreshold: 5,
  excessiveReportsWindowSec: 300,
} as ModerationDetectorConfig;

const reportSignal = (): ModerationSignal => ({
  type: 'report',
  roomId: 'r1',
  targetUserId: 'u2',
});

describe('ExcessiveReportsDetector', () => {
  let redis: { incr: jest.Mock; expire: jest.Mock };
  let detector: ExcessiveReportsDetector;

  beforeEach(() => {
    redis = { incr: jest.fn().mockResolvedValue(1), expire: jest.fn().mockResolvedValue(1) };
    detector = new ExcessiveReportsDetector(redis as never);
  });

  it('is labelled "excessive-reports"', () => {
    expect(detector.kind).toBe('excessive-reports');
  });

  it('ignores non-report signals', async () => {
    await expect(
      detector.evaluate({ type: 'join_leave', roomId: 'r1', userId: 'u1' }, CFG),
    ).resolves.toBeNull();
    expect(redis.incr).not.toHaveBeenCalled();
  });

  it('counts reports against the TARGET user on the windowed counter', async () => {
    await detector.evaluate(reportSignal(), CFG);
    expect(redis.incr).toHaveBeenCalledWith(reportCounterKey('r1', 'u2'));
    expect(redis.expire).toHaveBeenCalledWith(reportCounterKey('r1', 'u2'), 300);
  });

  it('returns null while under threshold', async () => {
    redis.incr.mockResolvedValue(4);
    await expect(detector.evaluate(reportSignal(), CFG)).resolves.toBeNull();
  });

  it('recommends auto_flag (ABUSE) once reports reach the threshold', async () => {
    redis.incr.mockResolvedValue(5);
    const result = await detector.evaluate(reportSignal(), CFG);
    expect(result).toMatchObject({
      action: 'auto_flag',
      meta: { reportReason: VideoRoomReportReason.ABUSE },
    });
  });
});
