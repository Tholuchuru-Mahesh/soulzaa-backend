import { Test, type TestingModule } from '@nestjs/testing';
import { LockService } from 'src/infra/redis/lock.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { PROFILE_SERVICE } from 'src/modules/users/interfaces/profile.interface';
import { WALLET_SERVICE } from 'src/modules/wallet/interfaces/wallet.service.interface';
import { CasinoGateway } from './gateway/casino.gateway';
import { CASINO_BROADCASTER } from './interfaces/casino-broadcaster.interface';
import { CasinoRepository } from './repositories/casino.repository';
import { CasinoLoopService } from './services/casino-loop.service';
import { CasinoService } from './services/casino.service';

/**
 * Task 12's circular-dependency proof.
 *
 * `CasinoLoopService` injects `CASINO_BROADCASTER` (useExisting-aliased, in
 * `CasinoModule`, to `CasinoGateway`), and `CasinoGateway` injects
 * `CasinoLoopService` right back (for `getState`, used to build `*_sync`
 * replies) — a genuine two-provider DI cycle. The regular unit specs for
 * these two classes (`casino.gateway.spec.ts`, `casino-loop.service.spec.ts`)
 * never exercise this: they `new` the classes directly with plain jest-mock
 * objects, bypassing Nest's container entirely, so they would pass even if
 * the real module wiring could never actually boot.
 *
 * This spec instead compiles the REAL `CasinoGateway`/`CasinoLoopService`
 * classes — with the real `useExisting` alias binding, exactly as
 * `CasinoModule` registers them — through an actual Nest `TestingModule`.
 * Every OTHER (non-cyclic) dependency is replaced by a minimal stand-in
 * (`useValue`/class-token override) so the module compiles without pulling in
 * Prisma/Redis/Wallet/Users/Socket infra. If either `forwardRef()` in
 * `casino.gateway.ts` / `casino-loop.service.ts` were ever dropped, `compile()`
 * below would reproduce Nest's real
 * "Nest can't resolve dependencies of CasinoLoopService (..., ?, ...).
 *  Please make sure that the argument CASINO_BROADCASTER at index [3] is
 *  available in the current context... potential circular dependency"
 * failure right here, instead of only at server boot.
 */
describe('Casino DI graph — CasinoLoopService <-> CasinoGateway cycle', () => {
  let moduleRef: TestingModule;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        CasinoGateway,
        CasinoLoopService,
        // The real alias binding from casino.module.ts — this is the edge
        // that turns "gateway needs loop" into an actual cycle.
        { provide: CASINO_BROADCASTER, useExisting: CasinoGateway },
        // Every other constructor dependency of the two cyclic providers,
        // stood in with a minimal double keyed to the real token/class.
        {
          provide: CasinoRepository,
          useValue: {
            listPlacedBets: jest.fn().mockResolvedValue([]),
            listUserBets: jest.fn().mockResolvedValue([]),
            recentWinningBets: jest.fn().mockResolvedValue([]),
            createRound: jest.fn(),
            runInTransaction: jest.fn(),
          },
        },
        {
          provide: CasinoService,
          useValue: {
            placeBet: jest.fn(),
            settleRound: jest.fn(),
            getWinHistory: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: LockService,
          useValue: {
            acquire: jest.fn(),
            release: jest.fn(),
            acquireLockObject: jest.fn(),
            extend: jest.fn(),
          },
        },
        {
          provide: SocketManager,
          useValue: {
            joinRoom: jest.fn().mockResolvedValue(undefined),
            leaveRoom: jest.fn().mockResolvedValue(undefined),
            emitToUser: jest.fn(),
            registerServer: jest.fn(),
            register: jest.fn().mockResolvedValue(true),
            unregister: jest.fn().mockResolvedValue(true),
            authMiddleware: jest.fn(),
          },
        },
        { provide: WALLET_SERVICE, useValue: { getBalance: jest.fn() } },
        { provide: PROFILE_SERVICE, useValue: { resolvePublicIdentities: jest.fn() } },
      ],
    }).compile();
  });

  afterAll(async () => {
    // No .init() was called (so no setInterval timers were ever started by
    // CasinoLoopService.onModuleInit), but close() cleanly tears down the
    // container regardless.
    await moduleRef.close();
  });

  it('compiles: both providers resolve without a circular-dependency error', () => {
    const gateway = moduleRef.get(CasinoGateway);
    const loop = moduleRef.get(CasinoLoopService);
    expect(gateway).toBeInstanceOf(CasinoGateway);
    expect(loop).toBeInstanceOf(CasinoLoopService);
  });

  it('binds CASINO_BROADCASTER to the SAME gateway instance (useExisting alias)', () => {
    const gateway = moduleRef.get(CasinoGateway);
    const broadcaster = moduleRef.get(CASINO_BROADCASTER);
    expect(broadcaster).toBe(gateway);
  });

  it("injects the loop's real instance into the gateway (forwardRef actually delivered a value)", () => {
    const gateway = moduleRef.get(CasinoGateway) as unknown as { loop: CasinoLoopService };
    const loop = moduleRef.get(CasinoLoopService);
    expect(gateway.loop).toBeDefined();
    expect(gateway.loop).toBe(loop);
  });
});
