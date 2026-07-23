import { ModerationCleanupProcessor } from './moderation-cleanup.processor';

describe('ModerationCleanupProcessor', () => {
  const support = {
    metrics: { observeDuration: jest.fn(), incCompleted: jest.fn(), incFailed: jest.fn() },
  };
  let moderationRepo: { expireMutes: jest.Mock };
  let processor: ModerationCleanupProcessor;

  beforeEach(() => {
    moderationRepo = { expireMutes: jest.fn().mockResolvedValue(3) };
    processor = new ModerationCleanupProcessor(support as never, moderationRepo as never);
  });

  it('bulk-expires past-due temporary mutes on an "expire-mutes" job (idempotent housekeeping)', async () => {
    const job = { name: 'expire-mutes', data: {} } as never;

    await expect(processor.handle(job)).resolves.toEqual({ expired: 3 });
    expect(moderationRepo.expireMutes).toHaveBeenCalledWith(expect.any(Date));
  });

  it('is a safe no-op for an unknown job name', async () => {
    const job = { name: 'something-else', data: {} } as never;

    await expect(processor.handle(job)).resolves.toEqual({ ok: true, unhandled: true });
    expect(moderationRepo.expireMutes).not.toHaveBeenCalled();
  });
});
