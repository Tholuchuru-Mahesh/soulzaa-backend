import { Module } from '@nestjs/common';
import { CASINO_BROADCASTER } from './interfaces/casino-broadcaster.interface';
import { CasinoRoomController } from './controllers/casino-room.controller';
import { RoomCasinoWindowListener } from './listeners/room-casino-window.listener';
import { CasinoRepository } from './repositories/casino.repository';
import { CasinoLoopService } from './services/casino-loop.service';
import { CasinoService } from './services/casino.service';
import { RoomCasinoWindowMonitor } from './services/room-casino-window.monitor';
import { RoomCasinoWindowService } from './services/room-casino-window.service';
import { CasinoGateway } from './gateway/casino.gateway';

/**
 * Casino domain (house-banked Greedy Food + Lucky Fruit) — the 24/7
 * betting→spinning→results round loop (`CasinoLoopService`, one leader-locked
 * instance drives both games), server-funded bet placement/settlement
 * (`CasinoService`/`CasinoRepository`), and the inbound `/casino` socket
 * gateway (`CasinoGateway`) that both serves clients AND implements the
 * `CasinoBroadcaster` seam the loop calls back through.
 *
 * No `imports` array: every dependency this module's providers reach for
 * (`PrismaService`, `WALLET_SERVICE`, `PROFILE_SERVICE`, `LockService`,
 * `SocketManager`) comes from a `@Global()` module (Prisma/Wallet/Users/
 * Redis/Socket — see InfraModule) already wired in at the app root, exactly
 * like `GamesModule` needs no explicit imports for the same reason.
 *
 * `CasinoGateway` is registered here (not in `infra/socket`'s `SOCKET_GATEWAYS`)
 * because — unlike the thin per-namespace shells there — it carries real
 * casino domain logic (`CasinoService`/`CasinoLoopService`/`CasinoRepository`
 * dependencies); Nest discovers `@WebSocketGateway()` providers regardless of
 * which module registers them, so a plain provider entry is sufficient.
 *
 * `CasinoLoopService` and `CasinoGateway` are mutually dependent (the loop
 * broadcasts through the `CASINO_BROADCASTER` token, aliased to the gateway;
 * the gateway reads `getState` off the loop for `*_sync` replies) — a genuine
 * DI cycle resolved with `forwardRef` on BOTH edges (see the `@Inject` sites
 * in `casino.gateway.ts` and `casino-loop.service.ts`).
 *
 * Audio-room windows: `RoomCasinoWindowService` (owner-gated start/close,
 * host-only bets, member-gated window sync) + `RoomCasinoWindowListener` (the
 * room-scoped mirror + room-end/room-delete close + ownership transfer) +
 * `RoomCasinoWindowMonitor` (Redis-locked orphan-window sweep) +
 * `CasinoRoomController` (the REST surface). These depend on
 * `GamesRepository`/`AudioRoomGameAuthzService` from the (global) GamesModule
 * and the global `AUDIO_ROOMS_SERVICE` — no module imports needed, mirroring
 * the rest of this module's zero-imports style.
 */
@Module({
  controllers: [CasinoRoomController],
  providers: [
    CasinoRepository,
    CasinoService,
    CasinoLoopService,
    CasinoGateway,
    RoomCasinoWindowService,
    RoomCasinoWindowListener,
    RoomCasinoWindowMonitor,
    { provide: CASINO_BROADCASTER, useExisting: CasinoGateway },
  ],
})
export class CasinoModule {}
