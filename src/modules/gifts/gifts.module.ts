import { Global, Module } from '@nestjs/common';
import { GiftAdminController } from './controllers/gift-admin.controller';
import { GiftController } from './controllers/gift.controller';
import { GIFTS_SERVICE } from './interfaces/gifts.service.interface';
import { GiftRepository } from './repositories/gift.repository';
import { GiftCatalogSeeder } from './services/gift-catalog.seeder.service';
import { GiftCatalogService } from './services/gift-catalog.service';
import { GiftContextRegistry } from './services/gift-context.registry';
import { GiftLeaderboardService } from './services/gift-leaderboard.service';
import { GiftService } from './services/gift.service';

/**
 * Gifts domain (AR-5) — the gift catalog, the immutable gift-send ledger,
 * combo/lucky mechanics, creator earnings, EXP seam, and the live top-gifter/
 * receiver leaderboards. Coin movement is delegated to the wallet (WALLET_SERVICE);
 * context validation to AUDIO_ROOMS_SERVICE; realtime room fan-out flows through
 * EVENT_BUS → the audio-rooms gift socket bridge.
 *
 * @Global so later gifting contexts (video rooms, live streaming, treasure boxes)
 * resolve GIFTS_SERVICE by token without importing this module.
 */
@Global()
@Module({
  controllers: [GiftController, GiftAdminController],
  providers: [
    GiftRepository,
    GiftCatalogService,
    GiftContextRegistry,
    GiftLeaderboardService,
    GiftService,
    GiftCatalogSeeder,
    { provide: GIFTS_SERVICE, useExisting: GiftCatalogService },
  ],
  // GiftContextRegistry + GiftService are exported so each gifting context's
  // module can register its handler and drive the shared send pipeline (VR-10).
  exports: [GIFTS_SERVICE, GiftContextRegistry, GiftService],
})
export class GiftsModule {}
