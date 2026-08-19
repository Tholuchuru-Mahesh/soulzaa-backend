// src/modules/platform-moderation/platform-moderation.module.ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { SocketModule } from 'src/infra/socket/socket.module';
import { PlatformModerationAdminController } from './controllers/platform-moderation-admin.controller';
import { PlatformBanRepository } from './repositories/platform-ban.repository';
import { PlatformBanReconciliationScheduler } from './services/platform-ban-reconciliation.scheduler';
import { PlatformBanService } from './services/platform-ban.service';
import { PlatformModerationAuditService } from './services/platform-moderation-audit.service';

@Module({
  imports: [PrismaModule, RedisModule, SocketModule],
  controllers: [PlatformModerationAdminController],
  providers: [
    PlatformBanRepository,
    PlatformBanService,
    PlatformModerationAuditService,
    PlatformBanReconciliationScheduler,
  ],
  exports: [PlatformBanService, PlatformModerationAuditService],
})
export class PlatformModerationModule {}
