import { Module } from '@nestjs/common';
import { CASINO_BROADCASTER } from './interfaces/casino-broadcaster.interface';
import { CasinoRepository } from './repositories/casino.repository';
import { CasinoLoopService } from './services/casino-loop.service';
import { CasinoService } from './services/casino.service';
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
 */
@Module({
  providers: [
    CasinoRepository,
    CasinoService,
    CasinoLoopService,
    CasinoGateway,
    { provide: CASINO_BROADCASTER, useExisting: CasinoGateway },
  ],
})
export class CasinoModule {}
