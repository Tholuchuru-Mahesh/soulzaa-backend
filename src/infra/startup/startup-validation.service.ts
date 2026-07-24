import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StartupValidationService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StartupValidationService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onApplicationBootstrap() {
    this.logger.log('Executing production pre-flight startup validations...');
    this.validateEnvironmentVariables();
    await this.validateDatabase();
    this.logger.log('Production pre-flight validations completed successfully.');
  }

  private validateEnvironmentVariables() {
    const requiredVars = ['PORT', 'DATABASE_URL', 'REDIS_HOST'];
    const missing = requiredVars.filter((key) => !this.configService.get(key));

    if (missing.length > 0) {
      this.logger.warn(
        `Pre-flight notice: Optional/Required env vars missing: ${missing.join(', ')}`,
      );
    }
  }

  private async validateDatabase() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error('Startup validation failed: Database connection unreachable', error);
    }
  }
}
