import { InvestigationRecordingExpiryScheduler } from './investigation-recording-expiry.scheduler';

describe('InvestigationRecordingExpiryScheduler', () => {
  let recordings: any;
  let scheduler: InvestigationRecordingExpiryScheduler;

  beforeEach(() => {
    recordings = { expireStaleRecordings: jest.fn().mockResolvedValue(0) };
    scheduler = new InvestigationRecordingExpiryScheduler(recordings);
  });

  it('sweeps stale recordings on each tick', async () => {
    await scheduler.handleStaleRecordings();
    expect(recordings.expireStaleRecordings).toHaveBeenCalled();
  });

  it('swallows errors so a bad tick does not crash the scheduler', async () => {
    recordings.expireStaleRecordings.mockRejectedValue(new Error('db down'));
    await expect(scheduler.handleStaleRecordings()).resolves.toBeUndefined();
  });
});
