/**
 * Public contract for the room-utilities module. Other modules depend only on
 * this token. Exposes a single aggregate read used for connection-recovery so a
 * reconnecting client can restore any live poll / countdown / spin wheel.
 */
export const ROOM_UTILITIES_SERVICE = Symbol('ROOM_UTILITIES_SERVICE');

export interface IRoomUtilitiesService {
  /** Aggregate live utility state in a room (active poll, countdown, wheels). */
  getActiveState(roomId: string): Promise<{
    poll: unknown;
    countdown: unknown;
    spinWheel: unknown;
  }>;
}
