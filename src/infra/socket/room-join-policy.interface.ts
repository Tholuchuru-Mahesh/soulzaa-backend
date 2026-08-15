/**
 * Opt-in authorization hook for `SocketManager.joinRoom`. Without one, joining
 * a Socket.IO room by id is unauthenticated-but-unauthorized: any connected
 * socket on the namespace can `room:join` any room string, since `joinRoom`
 * itself performs no membership check (see its doc comment). A namespace that
 * needs its rooms actually gated — `/games`, `/casino` — registers a policy
 * here; every other namespace (`/audio-room`, `/chat`, `/video-room`, `/live`,
 * `/gifts`, `/notifications`, `/call`) registers nothing and keeps today's
 * unrestricted behavior unchanged.
 *
 * `'player'` and `'spectator'` are both allowed to join; the distinction lets
 * the caller cache a spectator's socket (see `SocketManager.joinRoom`) so
 * hot-path handlers can block write actions in O(1) without a DB round trip
 * per event.
 */
export interface RoomJoinPolicy {
  canJoin(userId: string, roomId: string): Promise<'player' | 'spectator' | 'deny'>;
}

/** DI token for the namespace-path-keyed policy registry (empty by default). */
export const ROOM_JOIN_POLICY_REGISTRY = Symbol('ROOM_JOIN_POLICY_REGISTRY');

/** Keyed by namespace path, e.g. `/games`, `/casino`. */
export type RoomJoinPolicyRegistry = Map<string, RoomJoinPolicy>;
