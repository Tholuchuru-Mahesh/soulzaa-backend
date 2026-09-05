import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type { ExtendedError } from 'socket.io/dist/namespace';
import { PLATFORM_ROLES, type PlatformRole } from '../../common/constants';
import { EVENT_BUS, type IEventBus } from '../../common/events';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user';
import { ROLE_SOURCE, type IRoleSource } from '../../common/interfaces/role-source.interface';
import { MonitoringMetrics } from '../observability/monitoring.metrics';
import { PresenceService } from '../redis/presence.service';
import { TokenService } from '../auth/token.service';
import { PresenceChangedEvent } from './presence.events';
import {
  ROOM_JOIN_POLICY_REGISTRY,
  type RoomJoinPolicyRegistry,
} from './room-join-policy.interface';

/** Socket.IO middleware signature (namespace-level `server.use`). */
type SocketMiddleware = (socket: Socket, next: (err?: ExtendedError) => void) => void;

/** Room every one of a user's sockets joins, so we can target a user cross-instance. */
function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Namespaces where a MODERATOR/ADMIN/SUPER_ADMIN joining a room must stay
 * fully incognito — excluded from public presence and never announced to
 * the room. Scoped deliberately (not every BaseGateway namespace) so this
 * doesn't change behavior for /chat, /games, /gifts, /casino, etc., which
 * were never part of the incognito-moderation feature.
 */
const INCOGNITO_MODERATION_NAMESPACES = new Set(['/audio-room', '/video-room', '/live']);

function isModeratorUser(user: AuthenticatedUser): boolean {
  return (user.roles ?? []).some((r) => r === 'MODERATOR' || r === 'ADMIN' || r === 'SUPER_ADMIN');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a Socket.IO room name also identifies a row in the database.
 *
 * Socket room names are just strings, and not all of them are rooms anyone can
 * look up: the casino games broadcast through permanent lobby channels
 * (`greedy_food_global`, `lucky_fruit_global`), and any gateway may add more.
 * Every persisted room id, by contrast, is a `@db.Uuid` column — `AudioRoom.id`,
 * `RoomVisitor.roomId`, `RoomMember.roomId`, `PresenceState.currentRoomId` —
 * so a name that is not a UUID cannot possibly name a row.
 *
 * This matters because [SocketManager.joinRoom] publishes `room.joined`, which
 * is the SAME name as `AUDIO_ROOM_EVENTS.JOINED`. Every audio-room subscriber
 * therefore runs on any socket join, and for a lobby channel they hand a
 * channel name to a UUID column, which Postgres rejects outright:
 *
 *   Inconsistent column data: Error creating UUID, invalid character:
 *   ... found `g` at 1        ← 'greedy_food_global'
 *
 * — a burst of noisy failures (analytics visitor rows, presence
 * `currentRoomId`, the member roster) every time someone opens a casino game.
 *
 * Only the database-facing domain events are gated on this. The realtime side
 * of a lobby join is untouched: the socket still joins the channel, still
 * receives its broadcasts, and Redis presence still counts it.
 */
export function isPersistedRoomId(roomId: string): boolean {
  return UUID_RE.test(roomId);
}

/**
 * Central connection manager shared by every namespace gateway. Owns:
 *  - handshake JWT authentication (as Socket.IO middleware),
 *  - connection registration + presence tracking + cleanup,
 *  - room join/leave kept in sync between the socket and the Redis presence store,
 *  - cross-instance targeting of a user (via a per-user room + the Redis adapter),
 *  - a fast in-memory view of local sockets for metrics/lookups.
 *
 * Authoritative, cross-instance presence lives in PresenceService (Redis);
 * the local maps here are just this instance's slice.
 */
@Injectable()
export class SocketManager {
  private readonly logger = new Logger(SocketManager.name);

  // Local (this-instance) connection tracking.
  private readonly socketsByUser = new Map<string, Set<string>>();
  private readonly userBySocket = new Map<string, string>();
  // Namespace servers registered by each gateway's afterInit — lets non-gateway
  // callers (e.g. the session logout listener) target a user without a Server ref.
  private readonly servers = new Set<Server>();
  // 15-second grace period timers for unexpected room socket disconnections
  private readonly roomDisconnectTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly tokenService: TokenService,
    private readonly presence: PresenceService,
    private readonly metrics: MonitoringMetrics,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(ROLE_SOURCE) private readonly roleSource: IRoleSource,
    @Inject(ROOM_JOIN_POLICY_REGISTRY) private readonly joinPolicies: RoomJoinPolicyRegistry,
  ) {}

  /**
   * Namespace middleware that authenticates the handshake and stashes the user
   * on `socket.data.user`. Rejecting here refuses the connection before the
   * gateway's `connection` event fires.
   */
  authMiddleware(): SocketMiddleware {
    return (socket, next) => {
      const token = this.extractToken(socket);
      if (!token) {
        next(new Error('Unauthorized: missing token'));
        return;
      }
      this.tokenService
        .verifyAccessToken(token)
        .then(async (claims) => {
          // Roles from the RBAC store, not the claim: a connection outlives the
          // token that opened it, so a revoked role must not persist with it.
          const names = await this.roleSource.getRoleNames(claims.sub);
          const roles = names.filter((name): name is PlatformRole =>
            (PLATFORM_ROLES as readonly string[]).includes(name),
          );
          socket.data.user = { ...claims, id: claims.sub, roles };
          next();
        })
        .catch(() => next(new Error('Unauthorized: invalid token')));
    };
  }

  /**
   * Register an authenticated socket: join its per-user room, track it locally,
   * and record presence. Returns true when this is the user's first live socket.
   */
  async register(client: Socket): Promise<boolean> {
    const user = client.data.user as AuthenticatedUser;
    await client.join(userRoom(user.id));

    let sockets = this.socketsByUser.get(user.id);
    if (!sockets) {
      sockets = new Set();
      this.socketsByUser.set(user.id, sockets);
    }
    sockets.add(client.id);
    this.userBySocket.set(client.id, user.id);
    this.metrics.setConnectedClients(this.userBySocket.size);

    const firstConnection = await this.presence.connect(user.id, client.id);
    if (firstConnection) {
      await this.bus.publish(new PresenceChangedEvent({ userId: user.id, online: true }));
    }
    return firstConnection;
  }

  /**
   * Clean up a disconnected socket: drop presence, leave any rooms it was in,
   * and untrack it locally. Returns true when it was the user's last socket.
   */
  async unregister(client: Socket): Promise<boolean> {
    const userId = this.userBySocket.get(client.id) ?? (client.data.user as AuthenticatedUser)?.id;
    if (!userId) return false;

    // Check which rooms this disconnecting socket was joined into
    const joinedRooms = client.data.activeRooms as Set<string> | undefined;
    const socketNamespace = client.data.socketNamespace as string | undefined;

    try {
      const last = await this.presence.disconnect(userId, client.id);

      const sockets = this.socketsByUser.get(userId);
      sockets?.delete(client.id);
      if (sockets && sockets.size === 0) this.socketsByUser.delete(userId);
      this.userBySocket.delete(client.id);
      this.metrics.setConnectedClients(this.userBySocket.size);

      // Handle room disconnect grace periods if the socket dropped unexpectedly
      if (joinedRooms && joinedRooms.size > 0) {
        for (const roomId of joinedRooms) {
          if (isPersistedRoomId(roomId)) {
            const timerKey = `${roomId}:${userId}`;
            if (this.roomDisconnectTimers.has(timerKey)) {
              clearTimeout(this.roomDisconnectTimers.get(timerKey)!);
            }
            const timeout = setTimeout(async () => {
              this.roomDisconnectTimers.delete(timerKey);
              await this.handleRoomDisconnectTimeout(roomId, userId, socketNamespace);
            }, 15000);
            timeout.unref();
            this.roomDisconnectTimers.set(timerKey, timeout);
          }
        }
      }

      // On the user's last socket, clear their room memberships from the store.
      if (last) {
        const rooms = await this.presence.userRooms(userId);
        await Promise.all(rooms.map((roomId) => this.presence.leaveRoomEverywhere(roomId, userId)));
        await this.bus.publish(new PresenceChangedEvent({ userId, online: false }));
      }
      return last;
    } catch (err) {
      this.logger.verbose(
        `Redis presence deregistration failed on disconnect: ${(err as Error).message}`,
      );

      // Still clean up local socket mapping to prevent memory leak
      const sockets = this.socketsByUser.get(userId);
      sockets?.delete(client.id);
      if (sockets && sockets.size === 0) this.socketsByUser.delete(userId);
      this.userBySocket.delete(client.id);
      this.metrics.setConnectedClients(this.userBySocket.size);

      return false;
    }
  }

  /**
   * Called when a disconnected socket's 15-second grace period expires without reconnection.
   */
  async handleRoomDisconnectTimeout(roomId: string, userId: string, namespace?: string): Promise<void> {
    try {
      // Check if user has reconnected and is currently active in the room
      const stillActive = await this.presence.isInRoom(roomId, userId);
      const liveSockets = this.socketsByUser.get(userId);
      if (stillActive && liveSockets && liveSockets.size > 0) {
        return;
      }

      await this.presence.leaveRoomEverywhere(roomId, userId);
      const ns = namespace || '/audio-room';
      this.emitToNamespaceRoom(ns, roomId, 'room:member_left', { roomId, userId });
      this.emitToNamespaceRoom(ns, roomId, 'video_room:member_left', { roomId, userId });

      if (isPersistedRoomId(roomId)) {
        await this.bus.publish({
          name: 'audio_room.force_leave',
          payload: { roomId, userId },
          timestamp: new Date(),
        } as any);
      }
    } catch (err) {
      this.logger.verbose(`Error in handleRoomDisconnectTimeout for ${userId} in ${roomId}: ${(err as Error).message}`);
    }
  }

  /**
   * Immediately ejects a user from all rooms without a grace period (used on logout, account switch, ban).
   */
  async leaveUserRoomsImmediately(userId: string): Promise<void> {
    try {
      // Cancel any pending timers for this user
      for (const [key, timer] of this.roomDisconnectTimers.entries()) {
        if (key.endsWith(`:${userId}`)) {
          clearTimeout(timer);
          this.roomDisconnectTimers.delete(key);
        }
      }

      const rooms = await this.presence.userRooms(userId);
      await Promise.all(
        rooms.map(async (roomId) => {
          await this.presence.leaveRoomEverywhere(roomId, userId);
          this.emitToNamespaceRoom('/audio-room', roomId, 'room:member_left', { roomId, userId });
          this.emitToNamespaceRoom('/video-room', roomId, 'video_room:member_left', { roomId, userId });
          if (isPersistedRoomId(roomId)) {
            await this.bus.publish({
              name: 'audio_room.force_leave',
              payload: { roomId, userId },
              timestamp: new Date(),
            } as any);
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`Failed to immediately leave rooms for user ${userId}: ${(err as Error).message}`);
    }
  }

  /**
   * Join a room: keep the socket room and the Redis presence set in sync.
   *
   * `namespace` (a namespace path, e.g. `/games`) is optional and, when
   * given, is looked up in `ROOM_JOIN_POLICY_REGISTRY`. No namespace, or no
   * policy registered for it, joins unconditionally — the historical,
   * unrestricted behavior every caller had before this check existed. A
   * registered policy resolving `'deny'` refuses the join (the socket is
   * never added to the room) and emits `room:join_denied` to the caller
   * instead. A `'spectator'` resolution still joins the room, but is also
   * recorded on `client.data.spectatorRooms` so read-only hot-path handlers
   * (e.g. `game:aim`) can block writes in O(1) without re-querying.
   *
   * Returns whether the join actually happened, so callers (`BaseGateway
   * .onRoomJoin`) can reflect the real outcome to the client instead of
   * always acking success.
   */
  async joinRoom(client: Socket, roomId: string, namespace?: string): Promise<boolean> {
    const user = client.data.user as AuthenticatedUser;
    const policy = namespace ? this.joinPolicies.get(namespace) : undefined;
    if (policy) {
      const verdict = await policy.canJoin(user.id, roomId);
      if (verdict === 'deny') {
        client.emit('room:join_denied', { roomId });
        return false;
      }
      if (verdict === 'spectator') {
        const spectatorRooms = (client.data.spectatorRooms ??= new Set<string>());
        spectatorRooms.add(roomId);
      }
    }

    await client.join(roomId);

    // Track active rooms for this socket connection
    const activeRooms = (client.data.activeRooms ??= new Set<string>());
    activeRooms.add(roomId);
    client.data.socketNamespace = namespace;

    // Cancel any pending disconnect grace timer for this user in this room
    const timerKey = `${roomId}:${user.id}`;
    const timer = this.roomDisconnectTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.roomDisconnectTimers.delete(timerKey);
    }

    // Incognito moderators (see INCOGNITO_MODERATION_NAMESPACES) must never
    // be added to public presence or announced here — this generic handler
    // is a second join path every client also uses alongside each room
    // type's own REST join, so skipping it would silently unmask them.
    const incognito =
      namespace != null && INCOGNITO_MODERATION_NAMESPACES.has(namespace) && isModeratorUser(user);
    if (incognito) {
      await this.presence.joinRoom(roomId, user.id, true);
      return true;
    }

    await this.presence.joinRoom(roomId, user.id);

    // Track join timestamp for duration evaluation
    client.data.roomJoinedAt = client.data.roomJoinedAt || {};
    client.data.roomJoinedAt[roomId] = Date.now();
    client.data.roomLastEvaluatedAt = client.data.roomLastEvaluatedAt || {};
    client.data.roomLastEvaluatedAt[roomId] = Date.now();

    const payload = {
      roomId,
      userId: user?.id,
      username: user?.username ?? user?.name ?? 'User',
      name: user?.name,
      displayName: user?.name ?? user?.username ?? 'User',
      avatarUrl: user?.avatarUrl,
      joinedAt: new Date().toISOString(),
    };
    client.to(roomId).emit('video_room:member_joined', payload);
    client.to(roomId).emit('video_room.user_joined', payload);
    client.to(roomId).emit('room:member_joined', payload);
    client.to(roomId).emit('room.joined', payload);

    // Publish domain events for progression / task evaluation.
    // Only for a room that actually exists in the database — a socket-only
    // lobby channel has no row for these listeners to read or write, and
    // handing them one makes every UUID-column query fail (see
    // `isPersistedRoomId`).
    if (isPersistedRoomId(roomId)) {
      try {
        await this.bus.publish({
          name: namespace === '/video-room' ? 'video_room.joined' : 'audio_room.joined',
          payload: {
            roomId,
            userId: user.id,
            username: user?.username ?? user?.name ?? 'User',
            name: user?.name,
            avatarUrl: user?.avatarUrl,
            namespace,
          },
          timestamp: new Date(),
        } as any);
        await this.bus.publish({
          name: 'room.joined',
          payload: {
            roomId,
            userId: user.id,
            username: user?.username ?? user?.name ?? 'User',
            name: user?.name,
            avatarUrl: user?.avatarUrl,
            namespace,
          },
          timestamp: new Date(),
        } as any);
      } catch {
        // non-fatal
      }
    }

    return true;
  }

  /**
   * Heartbeat from client or periodic worker evaluating active room stay duration in realtime.
   */
  async heartbeatRoomStay(client: Socket, roomId: string): Promise<void> {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (!user?.id || !roomId) return;

    const joinedAt = client.data.roomJoinedAt?.[roomId] as number | undefined;
    if (!joinedAt) {
      client.data.roomJoinedAt = client.data.roomJoinedAt || {};
      client.data.roomJoinedAt[roomId] = Date.now();
      client.data.roomLastEvaluatedAt = client.data.roomLastEvaluatedAt || {};
      client.data.roomLastEvaluatedAt[roomId] = Date.now();
      return;
    }

    const lastEvaluated = (client.data.roomLastEvaluatedAt?.[roomId] as number | undefined) ?? joinedAt;
    const elapsedSinceLast = Date.now() - lastEvaluated;

    // Evaluate progress when at least 30 seconds have accumulated since last evaluation
    if (elapsedSinceLast >= 30000) {
      client.data.roomLastEvaluatedAt[roomId] = Date.now();
      const durationMinutes = Math.max(1, Math.floor(elapsedSinceLast / 60000) || 1);
      const durationSeconds = Math.round(elapsedSinceLast / 1000);
      const totalDurationMs = Date.now() - joinedAt;

      if (isPersistedRoomId(roomId)) {
        try {
          await this.bus.publish({
            name: 'room.duration_updated',
            payload: {
              userId: user.id,
              roomId,
              durationMinutes,
              durationSeconds,
              durationMs: totalDurationMs,
            },
            timestamp: new Date(),
          } as any);
        } catch {
          // non-fatal
        }
      }
    }
  }

  /** Leave a room: keep the socket room and the Redis presence set in sync. */
  async leaveRoom(client: Socket, roomId: string, namespace?: string): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    await client.leave(roomId);
    (client.data.spectatorRooms as Set<string> | undefined)?.delete(roomId);
    (client.data.activeRooms as Set<string> | undefined)?.delete(roomId);

    // Cancel any pending disconnect timer
    const timerKey = `${roomId}:${user.id}`;
    const timer = this.roomDisconnectTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.roomDisconnectTimers.delete(timerKey);
    }

    // Calculate room duration spent
    const joinedAt = client.data.roomJoinedAt?.[roomId] as number | undefined;
    if (joinedAt) {
      const lastEvaluated = (client.data.roomLastEvaluatedAt?.[roomId] as number | undefined) ?? joinedAt;
      delete client.data.roomJoinedAt[roomId];
      if (client.data.roomLastEvaluatedAt) {
        delete client.data.roomLastEvaluatedAt[roomId];
      }

      const totalDurationMs = Math.max(0, Date.now() - joinedAt);
      const remainingSinceLast = Math.max(0, Date.now() - lastEvaluated);
      const durationMinutes = Math.max(1, Math.round(remainingSinceLast / 60000) || (remainingSinceLast >= 15000 ? 1 : 0));
      const durationSeconds = Math.round(remainingSinceLast / 1000);

      if (isPersistedRoomId(roomId) && (durationMinutes > 0 || durationSeconds >= 15)) {
        try {
          await this.bus.publish({
            name: 'room.duration_updated',
            payload: {
              userId: user.id,
              roomId,
              durationMinutes: Math.max(1, durationMinutes),
              durationSeconds,
              durationMs: totalDurationMs,
            },
            timestamp: new Date(),
          } as any);
        } catch {
          // non-fatal
        }
      }
    }

    const incognito =
      namespace != null && INCOGNITO_MODERATION_NAMESPACES.has(namespace) && isModeratorUser(user);
    if (incognito) {
      await this.presence.leaveRoom(roomId, user.id, true);
      return;
    }

    await this.presence.leaveRoom(roomId, user.id);
    const payload = {
      roomId,
      userId: user?.id,
      username: user?.username ?? user?.name ?? 'User',
      name: user?.name,
      displayName: user?.name ?? user?.username ?? 'User',
      avatarUrl: user?.avatarUrl,
      leftAt: new Date().toISOString(),
    };
    client.to(roomId).emit('video_room:member_left', payload);
    client.to(roomId).emit('video_room.user_left', payload);
    client.to(roomId).emit('room:member_left', payload);
    client.to(roomId).emit('room.left', payload);

    if (isPersistedRoomId(roomId)) {
      try {
        await this.bus.publish({
          name: 'audio_room.left',
          payload: {
            roomId,
            userId: user.id,
            username: user?.username ?? user?.name ?? 'User',
            name: user?.name,
            avatarUrl: user?.avatarUrl,
          },
          timestamp: new Date(),
        } as any);
      } catch {
        // non-fatal
      }
    }
  }

  /** Emit to all of a user's sockets across every instance (via the Redis adapter). */
  emitToUser(server: Server, userId: string, event: string, payload: unknown): void {
    server.to(userRoom(userId)).emit(event, payload);
  }

  /** Force-disconnect all of a user's sockets across every instance (e.g. logout). */
  disconnectUser(server: Server, userId: string): void {
    server.in(userRoom(userId)).disconnectSockets(true);
  }

  /** Called by each gateway's afterInit so the manager knows every namespace. */
  registerServer(server: Server): void {
    this.servers.add(server);
  }

  /**
   * Emit an event to a user across every registered namespace (cross-instance
   * via the Redis adapter), without a Server ref. Used by non-gateway callers
   * (e.g. the privacy module) to push realtime updates like `privacy:updated`.
   */
  emitToUserEverywhere(userId: string, event: string, payload: unknown): void {
    for (const server of this.servers) {
      server.to(userRoom(userId)).emit(event, payload);
    }
  }

  /** Broadcast an event to ALL connected clients across every registered namespace. */
  emitEverywhere(event: string, payload: unknown): void {
    for (const server of this.servers) {
      server.emit(event, payload);
    }
  }

  /**
   * Force-disconnect a user across every registered namespace (cross-instance via
   * the Redis adapter). Used by the session module on force-logout so live
   * sockets are torn down and presence cleans up (PRD "Mark User Offline").
   */
  disconnectUserEverywhere(userId: string): void {
    for (const server of this.servers) {
      server.in(userRoom(userId)).disconnectSockets(true);
    }
  }

  /**
   * Force-disconnect a user's sockets within one registered namespace only
   * (cross-instance via the Redis adapter) — the namespace-scoped counterpart
   * to `disconnectUserEverywhere`. Domain moderation actions (e.g. a Video
   * Room kick/blacklist) must use this instead of the "everywhere" variant:
   * severing only the target's sockets in the acting namespace, leaving their
   * DMs, 1:1 calls, other rooms, etc. untouched. Mirrors `emitToNamespaceRoom`
   * — the namespace is matched by its path; a no-op if that namespace has not
   * initialised yet.
   */
  disconnectUserInNamespace(namespace: string, userId: string): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`disconnectUserInNamespace: no server for namespace "${namespace}"`);
      return;
    }
    this.disconnectUser(server, userId);
  }

  /**
   * Remove a user from a specific room channel in a namespace, leaving their
   * socket connection open to receive targeted events (e.g. moderation notices).
   */
  leaveRoomInNamespace(namespace: string, roomId: string, userId: string): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`leaveRoomInNamespace: no server for namespace "${namespace}"`);
      return;
    }
    server.in(userRoom(userId)).socketsLeave(roomId);
  }

  /**
   * Emit an event to one user's sockets within a single namespace only (e.g.
   * `/live`), leaving their sockets on every other namespace — DMs, other
   * rooms, calling, etc. — untouched. Mirrors `disconnectUserInNamespace`'s
   * namespace resolution. A no-op if that namespace has not initialised yet.
   */
  emitToUserInNamespace(namespace: string, userId: string, event: string, payload: unknown): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`emitToUserInNamespace: no server for namespace "${namespace}"`);
      return;
    }
    this.emitToUser(server, userId, event, payload);
  }

  /**
   * Broadcast an event to everyone in a room on a specific namespace (e.g.
   * `/audio-room`), cross-instance via the Redis adapter. Domain modules push
   * realtime room updates through this from an event-bus listener rather than
   * depending on a gateway directly (mirrors how the session module uses the
   * manager). The namespace is matched by its path; a no-op if that namespace
   * has not initialised yet.
   */
  emitToNamespaceRoom(namespace: string, roomId: string, event: string, payload: unknown): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`emitToNamespaceRoom: no server for namespace "${namespace}"`);
      return;
    }
    server.to(roomId).emit(event, payload);
  }

  /**
   * Broadcast an event to every socket connected to a namespace, cross-instance
   * via the Redis adapter. The namespace-wide counterpart to
   * `emitToNamespaceRoom`, for lobby-level facts that must reach clients which
   * are not (or are no longer) subscribed to any particular room's channel — a
   * room going live again being the motivating case, since everyone who was
   * ejected when it closed has already left that room's channel.
   *
   * Use sparingly: every connected socket on the namespace receives the payload.
   * Anything addressed at a specific room or user belongs in
   * `emitToNamespaceRoom` / `emitToUser`. A no-op if the namespace has not
   * initialised yet.
   */
  emitToNamespace(namespace: string, event: string, payload: unknown): void {
    const server = this.serverForNamespace(namespace);
    if (!server) {
      this.logger.warn(`emitToNamespace: no server for namespace "${namespace}"`);
      return;
    }
    server.emit(event, payload);
  }

  /**
   * Resolve a registered namespace server by its path (e.g. `/audio-room`).
   * Gateways register their namespace-scoped server (a Socket.IO Namespace,
   * whose `.name` is the path) via `registerServer`.
   */
  private serverForNamespace(namespace: string): Server | undefined {
    for (const server of this.servers) {
      if ((server as unknown as { name: string }).name === namespace) return server;
    }
    return undefined;
  }

  /** Rooms a user is currently connected to. */
  async getUserRooms(userId: string): Promise<string[]> {
    return this.presence.userRooms(userId);
  }

  /** Local socket ids for a user on this instance. */
  socketsForUser(userId: string): string[] {
    return [...(this.socketsByUser.get(userId) ?? [])];
  }

  /** Total sockets currently tracked on this instance. */
  localSocketCount(): number {
    return this.userBySocket.size;
  }

  private extractToken(client: Socket): string | undefined {
    const authToken = client.handshake?.auth?.token as string | undefined;
    if (authToken) return authToken.replace(/^Bearer\s+/i, '');
    const header = client.handshake?.headers?.authorization;
    return header?.replace(/^Bearer\s+/i, '');
  }
}
