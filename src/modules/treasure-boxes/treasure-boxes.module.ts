import { Global, Module } from '@nestjs/common';
import { TreasureAdminController } from './controllers/treasure-admin.controller';
import { TreasureController } from './controllers/treasure.controller';
import { TREASURE_BOXES_SERVICE } from './interfaces/treasure-boxes.service.interface';
import { TreasureGiftListener } from './listeners/treasure-gift.listener';
import { RocketRepository } from './repositories/rocket.repository';
import { TreasureRepository } from './repositories/treasure.repository';
import { RewardDistributor } from './services/reward-distributor.service';
import { RocketExpiryMonitor } from './services/rocket-expiry.monitor';
import { RocketService } from './services/rocket.service';
import { TreasureAdminService } from './services/treasure-admin.service';
import { TreasureConfigSeeder } from './services/treasure-config.seeder.service';
import { TreasureService } from './services/treasure.service';

/**
 * Treasure Boxes & Rocket Events (AR-6) — gift-driven room reward events. A room
 * owner/admin runs a 5-box treasure ladder; gift value (from GiftSentEvent) fills
 * the current box which auto-opens, ranks its Top-3 gifters, and distributes
 * rewards (coins→wallet, items→backpack) before advancing. Premium trigger gifts
 * launch timed rocket events that pay out their pool on expiry. Realtime fan-out
 * flows through EVENT_BUS → the audio-rooms treasure socket bridge.
 *
 * @Global so the read seam (TREASURE_BOXES_SERVICE) is resolvable by later
 * gifting contexts without importing this module.
 */
@Global()
@Module({
  controllers: [TreasureController, TreasureAdminController],
  providers: [
    TreasureRepository,
    RocketRepository,
    RewardDistributor,
    TreasureService,
    RocketService,
    TreasureAdminService,
    TreasureConfigSeeder,
    TreasureGiftListener,
    RocketExpiryMonitor,
    { provide: TREASURE_BOXES_SERVICE, useExisting: TreasureService },
  ],
  exports: [TREASURE_BOXES_SERVICE],
})
export class TreasureBoxesModule {}
