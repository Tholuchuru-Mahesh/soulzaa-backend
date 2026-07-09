import { Global, Module } from '@nestjs/common';
import { ExpAdminController } from './controllers/exp-admin.controller';
import { ExpController } from './controllers/exp.controller';
import { EXP_SERVICE } from './interfaces/exp.service.interface';
import { ExpActivityListener } from './listeners/exp-activity.listener';
import { ExpRepository } from './repositories/exp.repository';
import { ExpAdminService } from './services/exp-admin.service';
import { ExpConfigSeeder } from './services/exp-config.seeder.service';
import { ExpRewardGranter } from './services/exp-reward.granter';
import { ExpService } from './services/exp.service';

/**
 * EXP & Levels (AR-7) — user and room experience points with immutable ledgers,
 * admin-configurable level ladders, and auto-level-up granting free coins +
 * cosmetics (via the wallet + cosmetics/backpack). Accrues from gifts and room
 * joins (consumed from domain events) and exposes EXP_SERVICE for other sources.
 *
 * @Global so daily-tasks/games/live modules award EXP by token without importing
 * this module.
 */
@Global()
@Module({
  controllers: [ExpController, ExpAdminController],
  providers: [
    ExpRepository,
    ExpRewardGranter,
    ExpService,
    ExpAdminService,
    ExpConfigSeeder,
    ExpActivityListener,
    { provide: EXP_SERVICE, useExisting: ExpService },
  ],
  exports: [EXP_SERVICE],
})
export class ExpModule {}
