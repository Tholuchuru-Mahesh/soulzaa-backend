import { Global, Module } from '@nestjs/common';
import { CosmeticsAdminController } from './controllers/cosmetics-admin.controller';
import { CosmeticsStoreController } from './controllers/cosmetics-store.controller';
import { CosmeticsController } from './controllers/cosmetics.controller';
import { COSMETICS_SERVICE } from './interfaces/cosmetics.service.interface';
import { CosmeticsRepository } from './repositories/cosmetics.repository';
import { CosmeticsStoreService } from './services/cosmetics-store.service';
import { CosmeticsService } from './services/cosmetics.service';

/**
 * Cosmetics domain (AR-7) — the admin-managed catalog of frames, badges,
 * entrance effects, themes and decorations, the single seam through which the
 * EXP/level, VIP, treasure and event systems award them into the backpack, and
 * the premium store (AR-9) where users buy premium cosmetics with gold.
 *
 * @Global so those features resolve COSMETICS_SERVICE by token without importing
 * this module.
 */
@Global()
@Module({
  controllers: [CosmeticsController, CosmeticsAdminController, CosmeticsStoreController],
  providers: [
    CosmeticsRepository,
    CosmeticsService,
    CosmeticsStoreService,
    { provide: COSMETICS_SERVICE, useExisting: CosmeticsService },
  ],
  exports: [COSMETICS_SERVICE],
})
export class CosmeticsModule {}
