import { Global, Module } from '@nestjs/common';
import { FamiliesController } from './controllers/families.controller';
import { FAMILIES_SERVICE } from './interfaces/families.service.interface';
import { FamiliesRepository } from './repositories/families.repository';
import { FamiliesService } from './services/families.service';

/**
 * @Global so cross-module consumers (e.g. RankingsService) can resolve
 * FAMILIES_SERVICE by token without importing FamiliesModule — keeps the
 * dependency graph boundary-clean (mirrors AudioRoomsModule/WalletModule).
 */
@Global()
@Module({
  controllers: [FamiliesController],
  providers: [
    FamiliesRepository,
    FamiliesService,
    {
      provide: FAMILIES_SERVICE,
      useClass: FamiliesService,
    },
  ],
  exports: [FamiliesRepository, FamiliesService, FAMILIES_SERVICE],
})
export class FamiliesModule {}
