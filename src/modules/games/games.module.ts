import { Global, Module } from '@nestjs/common';
import { GamesAdminController } from './controllers/games-admin.controller';
import { GamesController } from './controllers/games.controller';
import { GAMES_SERVICE } from './interfaces/games.service.interface';
import { AudioRoomLifecycleListener } from './listeners/audio-room-lifecycle.listener';
import { GameSocketListener } from './listeners/game-socket.listener';
import { GamesRoomJoinPolicy } from './listeners/games-room-join-policy';
import { PresenceForfeitListener } from './listeners/presence-forfeit.listener';
import { GamesRepository } from './repositories/games.repository';
import { AudioRoomGameAuthzService } from './services/audio-room-game-authz.service';
import { GameCatalogSeeder } from './services/game-catalog.seeder';
import { GameExpiryMonitor } from './services/game-expiry.monitor';
import { GamesService } from './services/games.service';

/**
 * Games domain (AR-11) — the platform backend around games: an admin-configurable
 * catalog (Ludo + Carrom — the other six PRD games were removed as dead code;
 * see GAME_CATALOG_SEED), lobby matchmaking (create/join/leave/start by code),
 * entry-stake escrow (debit-on-start / refund-on-cancel) against the wallet in
 * the game's currency (GOLD for premium, FREE for casual), a trusted result
 * settlement seam with anti-cheat validation (participant/pot conservation),
 * an immutable economy ledger + audit log, live leaderboards, and match history.
 *
 * Per-game rule engines are intentionally NOT here — a trusted game engine
 * submits winners/payouts through `GAMES_SERVICE.settleResult` / the guarded
 * result endpoint; the platform validates and pays out but never derives the
 * outcome. Realtime fan-out flows through EVENT_BUS → GameSocketListener on the
 * `/games` namespace.
 *
 * @Global so a future in-process game engine can resolve GAMES_SERVICE by token.
 * Owns the game_* tables and the game leaderboards in Redis.
 */
@Global()
@Module({
  controllers: [GamesController, GamesAdminController],
  providers: [
    GamesRepository,
    GamesService,
    GameCatalogSeeder,
    GameExpiryMonitor,
    GameSocketListener,
    PresenceForfeitListener,
    AudioRoomGameAuthzService,
    GamesRoomJoinPolicy,
    AudioRoomLifecycleListener,
    { provide: GAMES_SERVICE, useExisting: GamesService },
  ],
  exports: [GAMES_SERVICE, GamesService, GamesRepository, AudioRoomGameAuthzService],
})
export class GamesModule {}
