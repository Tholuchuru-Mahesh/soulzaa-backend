import { Global, Module } from '@nestjs/common';
import { PLATFORM_CONFIG } from './interfaces/platform-configuration.interface';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { ConfigurationEngineService } from './services/configuration-engine.service';
import { ConfigurationHistoryService } from './services/configuration-history.service';
import { ConfigurationValidationService } from './services/configuration-validation.service';
import { FeatureFlagService } from './services/feature-flag.service';
import { PlatformConfigurationSeederService } from './services/platform-configuration-seeder.service';
import { SettingsQueryService } from './services/settings-query.service';

@Global()
@Module({
  imports: [PrismaModule, RedisModule],
  providers: [
    ConfigurationValidationService,
    ConfigurationHistoryService,
    ConfigurationEngineService,
    FeatureFlagService,
    SettingsQueryService,
    PlatformConfigurationSeederService,
    // Public port consumed by domain modules (see interfaces/).
    { provide: PLATFORM_CONFIG, useExisting: ConfigurationEngineService },
  ],
  exports: [
    ConfigurationValidationService,
    ConfigurationHistoryService,
    ConfigurationEngineService,
    FeatureFlagService,
    SettingsQueryService,
    PlatformConfigurationSeederService,
    PLATFORM_CONFIG,
  ],
})
export class PlatformConfigurationModule {}
