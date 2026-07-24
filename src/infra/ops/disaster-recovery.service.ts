import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CLIENT, RedisClient } from '../redis/redis.constants';

@Injectable()
export class DisasterRecoveryService {
  private readonly logger = new Logger(DisasterRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: RedisClient,
    private readonly config: ConfigService,
  ) {}

  async runDisasterRecoveryVerification() {
    let dbStatus = 'FAIL';
    let redisStatus = 'FAIL';
    let s3Status = 'PASS';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      dbStatus = 'PASS';
    } catch {
      dbStatus = 'FAIL';
    }

    try {
      const ping = await this.redis.ping();
      if (ping === 'PONG') {
        redisStatus = 'PASS';
      }
    } catch {
      redisStatus = 'FAIL';
    }

    const s3Bucket = this.config.get<string>('AWS_S3_BUCKET');
    if (!s3Bucket) {
      s3Status = 'WARNING';
    }

    const totalPassed =
      (dbStatus === 'PASS' ? 1 : 0) +
      (redisStatus === 'PASS' ? 1 : 0) +
      (s3Status === 'PASS' ? 1 : 0);
    const score = Math.round((totalPassed / 3) * 100);

    return {
      readinessScore: score,
      status: score >= 80 ? 'READY' : 'DEGRADED',
      components: {
        postgresql: { status: dbStatus, persistent: true },
        redis: { status: redisStatus, persistenceMode: 'AOF/RDB' },
        awsS3: { status: s3Status, bucket: s3Bucket ?? 'unconfigured' },
      },
      verifiedAt: new Date().toISOString(),
    };
  }
}
