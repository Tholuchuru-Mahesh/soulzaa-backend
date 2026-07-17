/**
 * Broadcast seam for the casino round loop (`CasinoLoopService`) — deliberately
 * NOT a direct import of `BaseGateway`/`CasinoGateway`. The `/casino` gateway
 * doesn't exist yet (it's Task 11); depending on a concrete gateway class here
 * would create a circular/forward module dependency (gateway needs the loop's
 * `getState` for its `*_sync` reply, loop needs the gateway to broadcast).
 *
 * Instead the loop depends on this small interface + injection token. Task 11's
 * `CasinoGateway` implements it (thin wrapper over `BaseGateway.emitToRoom` +
 * a room's live socket count) and Task 12 binds the token to that gateway
 * instance in the casino module (`{ provide: CASINO_BROADCASTER, useExisting: CasinoGateway }`
 * or equivalent — the gateway must be constructed before the loop starts ticking).
 */
export interface CasinoBroadcaster {
  /** Emit `event` with `payload` to every socket in `room` (Redis-adapter backed — reaches every instance's sockets). */
  emitToRoom(room: string, event: string, payload: unknown): void;

  /**
   * Number of sockets currently connected to `room` — used for the old apps'
   * `onlineCount` tick field (`getOnlineCount(io)` in both old socket files).
   * Only the gateway (which holds the Socket.IO server) can answer this; the
   * loop has no direct socket access.
   */
  onlineCount(room: string): number;
}

/** DI token for `CasinoBroadcaster` — see the class doc comment above. */
export const CASINO_BROADCASTER = Symbol('CASINO_BROADCASTER');
