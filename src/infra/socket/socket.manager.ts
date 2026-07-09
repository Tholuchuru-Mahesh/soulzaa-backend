import { Injectable, Logger } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type { ExtendedError } from 'socket.io/dist/namespace';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user';
import { MonitoringMetrics } from '../observability/monitoring.metrics';
import { PresenceService } from '../redis/presence.service';
import { TokenService } from '../auth/token.service';

/** Socket.IO middleware signature (namespace-level `server.use`). */
type SocketMiddleware = (socket: Socket, next: (err?: ExtendedError) => void) => void;

/** Room every one of a user's sockets joins, so we can target a user cross-instance. */
function userRoom(userId: string): string {
  return `user:${userId}`;
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

  constructor(
    private readonly tokenService: TokenService,
    private readonly presence: PresenceService,
    private readonly metrics: MonitoringMetrics,
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
        .then((claims) => {
          socket.data.user = { ...claims, id: claims.sub, roles: claims.roles ?? [] };
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

    return this.presence.connect(user.id, client.id);
  }

  /**
   * Clean up a disconnected socket: drop presence, leave any rooms it was in,
   * and untrack it locally. Returns true when it was the user's last socket.
   */
  async unregister(client: Socket): Promise<boolean> {
    const userId = this.userBySocket.get(client.id) ?? (client.data.user as AuthenticatedUser)?.id;
    if (!userId) return false;

    const last = await this.presence.disconnect(userId, client.id);

    const sockets = this.socketsByUser.get(userId);
    sockets?.delete(client.id);
    if (sockets && sockets.size === 0) this.socketsByUser.delete(userId);
    this.userBySocket.delete(client.id);
    this.metrics.setConnectedClients(this.userBySocket.size);

    // On the user's last socket, clear their room memberships from the store.
    if (last) {
      const rooms = await this.presence.userRooms(userId);
      await Promise.all(rooms.map((roomId) => this.presence.leaveRoom(roomId, userId)));
    }
    return last;
  }

  /** Join a room: keep the socket room and the Redis presence set in sync. */
  async joinRoom(client: Socket, roomId: string): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    await client.join(roomId);
    await this.presence.joinRoom(roomId, user.id);
  }

  /** Leave a room: keep the socket room and the Redis presence set in sync. */
  async leaveRoom(client: Socket, roomId: string): Promise<void> {
    const user = client.data.user as AuthenticatedUser;
    await client.leave(roomId);
    await this.presence.leaveRoom(roomId, user.id);
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
