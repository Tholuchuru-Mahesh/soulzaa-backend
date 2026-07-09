import { Global, Module } from '@nestjs/common';
import { BackpackController } from './controllers/backpack.controller';
import { BACKPACK_SERVICE } from './interfaces/backpack.service.interface';
import { BackpackRepository } from './repositories/backpack.repository';
import { BackpackService } from './services/backpack.service';

/**
 * Backpack domain — the user inventory of earned non-coin rewards (frames,
 * themes, entrance effects, badges, decorations) with idempotent grants,
 * one-per-type equipping, transfers, and an immutable action log.
 *
 * @Global so the economy features (treasure boxes, rocket events, VIP,
 * attendance) resolve BACKPACK_SERVICE by token without importing this module.
 */
@Global()
@Module({
  controllers: [BackpackController],
  providers: [
    BackpackRepository,
    BackpackService,
    { provide: BACKPACK_SERVICE, useExisting: BackpackService },
  ],
  exports: [BACKPACK_SERVICE],
})
export class BackpackModule {}
