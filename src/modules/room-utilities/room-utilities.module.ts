import { Global, Module } from '@nestjs/common';
import { CountdownController } from './controllers/countdown.controller';
import { InteractiveToolsController } from './controllers/interactive-tools.controller';
import { PollController } from './controllers/poll.controller';
import { SpinWheelController } from './controllers/spin-wheel.controller';
import { ROOM_UTILITIES_SERVICE } from './interfaces/room-utilities.service.interface';
import { CountdownRepository } from './repositories/countdown.repository';
import { InteractiveToolsRepository } from './repositories/interactive-tools.repository';
import { PollRepository } from './repositories/poll.repository';
import { SpinWheelRepository } from './repositories/spin-wheel.repository';
import { CoinFlipService } from './services/coin-flip.service';
import { CountdownService } from './services/countdown.service';
import { DiceService } from './services/dice.service';
import { PollService } from './services/poll.service';
import { RandomPickerService } from './services/random-picker.service';
import { RoomUtilAuthz } from './services/room-util-authz.service';
import { RoomUtilitiesService } from './services/room-utilities.service';
import { RoomUtilitiesTickMonitor } from './services/room-utilities-tick.monitor';
import { SpinWheelService } from './services/spin-wheel.service';

/**
 * Room Interactive Utilities (AR-15) — lightweight in-room host tools: polls,
 * dice, coin flip, random picker, spin wheel and countdown timer. Every outcome
 * is computed server-side (the client only animates it); host-only create
 * actions are enforced via AUDIO_ROOMS_SERVICE role checks, and coin rewards on
 * the spin wheel move through WALLET_SERVICE. Realtime fan-out flows through
 * EVENT_BUS → the audio-rooms room-utilities socket bridge; a fleet-wide tick
 * monitor drives countdown progress and poll auto-end.
 *
 * @Global so the read seam (ROOM_UTILITIES_SERVICE) is resolvable without
 * importing this module.
 */
@Global()
@Module({
  controllers: [
    PollController,
    InteractiveToolsController,
    SpinWheelController,
    CountdownController,
  ],
  providers: [
    PollRepository,
    InteractiveToolsRepository,
    SpinWheelRepository,
    CountdownRepository,
    RoomUtilAuthz,
    PollService,
    DiceService,
    CoinFlipService,
    RandomPickerService,
    SpinWheelService,
    CountdownService,
    RoomUtilitiesService,
    RoomUtilitiesTickMonitor,
    { provide: ROOM_UTILITIES_SERVICE, useExisting: RoomUtilitiesService },
  ],
  exports: [ROOM_UTILITIES_SERVICE],
})
export class RoomUtilitiesModule {}
