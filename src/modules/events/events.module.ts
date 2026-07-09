import { Global, Module } from '@nestjs/common';
import { EventsAdminController } from './controllers/events-admin.controller';
import { EventsController } from './controllers/events.controller';
import { EVENTS_SERVICE } from './interfaces/events.service.interface';
import { EventsRepository } from './repositories/events.repository';
import { EventRewardGranter } from './services/event-reward.granter';
import { EventsAdminService } from './services/events-admin.service';
import { EventsSeeder } from './services/events.seeder.service';
import { EventsService } from './services/events.service';

/**
 * Events (AR-8) — the seasonal/promotional event system. Claimable reward events
 * grant coins/cosmetics/EXP once per user (idempotent, immutable claim ledger);
 * multiplier events (double-recharge/double-EXP) expose a live multiplier via
 * EVENTS_SERVICE that the accrual pipelines apply.
 *
 * @Global so the EXP pipeline (and the future recharge flow) resolve
 * EVENTS_SERVICE by token without importing this module.
 */
@Global()
@Module({
  controllers: [EventsController, EventsAdminController],
  providers: [
    EventsRepository,
    EventRewardGranter,
    EventsService,
    EventsAdminService,
    EventsSeeder,
    { provide: EVENTS_SERVICE, useExisting: EventsService },
  ],
  exports: [EVENTS_SERVICE],
})
export class EventsModule {}
