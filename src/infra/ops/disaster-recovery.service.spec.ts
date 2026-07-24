import { DisasterRecoveryService } from './disaster-recovery.service';

/**
 * Defect 7: the S3 readiness check read `AWS_S3_BUCKET`, but the validated env
 * var is `S3_BUCKET` (env.validation.ts) — so the check always WARNed.
 */
describe('DisasterRecoveryService — S3 env var', () => {
  it('reads S3_BUCKET (not AWS_S3_BUCKET) for the S3 readiness check', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ ok: 1 }]) };
    const redis = { ping: jest.fn().mockResolvedValue('PONG') };
    const config = {
      get: jest.fn().mockImplementation((k: string) => (k === 'S3_BUCKET' ? 'soulzaa-media' : undefined)),
    };
    const svc = new DisasterRecoveryService(prisma as never, redis as never, config as never);

    const result = await svc.runDisasterRecoveryVerification();

    expect(config.get).toHaveBeenCalledWith('S3_BUCKET');
    expect(result.components.awsS3.status).toBe('PASS');
    expect(result.components.awsS3.bucket).toBe('soulzaa-media');
  });
});
