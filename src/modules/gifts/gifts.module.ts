import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { GiftController } from './controllers/gift.controller';
import { GiftsController } from './controllers/gifts.controller';
import { GIFTS_SERVICE } from './interfaces/gifts.service.interface';
import { GiftRepository } from './repositories/gift.repository';
import { GiftAuditService } from './services/gift-audit.service';
import { GiftAvailabilityService } from './services/gift-availability.service';
import { GiftCatalogSeederService } from './services/gift-catalog-seeder.service';
import { GiftCatalogService } from './services/gift-catalog.service';
import { GiftContextRegistry } from './services/gift-context.registry';
import { GiftHistoryService } from './services/gift-history.service';
import { GiftInventoryService } from './services/gift-inventory.service';
import { GiftLeaderboardService } from './services/gift-leaderboard.service';
import { GiftQueryService } from './services/gift-query.service';

import { StorageModule } from 'src/infra/storage/storage.module';
import { GiftService } from './services/gift.service';
import { FrameExpirationScheduler } from './services/frame-expiration.scheduler';

@Global()
@Module({
  imports: [PrismaModule, PlatformConfigurationModule, TreasuryModule, WalletModule, StorageModule],
  controllers: [GiftController, GiftsController],
  providers: [
    GiftRepository,
    GiftService,
    FrameExpirationScheduler,
    GiftContextRegistry,
    GiftAuditService,
    GiftCatalogService,
    GiftAvailabilityService,
    GiftInventoryService,
    GiftHistoryService,
    GiftQueryService,
    GiftLeaderboardService,
    GiftCatalogSeederService,
    { provide: GIFTS_SERVICE, useClass: GiftService },
  ],
  exports: [
    GIFTS_SERVICE,
    GiftRepository,
    GiftService,
    GiftContextRegistry,
    GiftAuditService,
    GiftCatalogService,
    GiftAvailabilityService,
    GiftInventoryService,
    GiftHistoryService,
    GiftQueryService,
    GiftLeaderboardService,
  ],
})
export class GiftsModule {}
