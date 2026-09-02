import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { AuthenticatedUser } from '../../common/interfaces/authenticated-user';
import { SocketManager } from './socket.manager';

/**
 * Base class for the namespace gateways (/chat, /live, /gifts, ...). Handles the
 * cross-cutting realtime concerns so each concrete gateway is a thin shell that
 * only declares its namespace (and, later, its domain message handlers):
 *  - handshake JWT auth via a namespace middleware (rejects before `connection`),
 *  - presence registration on connect and cleanup on disconnect,
 *  - generic `room:join` / `room:leave` / `ping` handlers,
 *  - `emitToRoom` / `emitToUser` broadcast helpers (Redis-adapter backed).
 *
 * Subclasses declare `@WebSocketServer() protected readonly server` and pass the
 * injected SocketManager to `super(manager)`.
 */
export abstract class BaseGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  protected abstract readonly server: Server;
  protected readonly logger = new Logger(this.constructor.name);

  constructor(protected readonly manager: SocketManager) {}

  afterInit(server: Server): void {
    // Authenticate the handshake for this namespace before any `connection`.
    server.use(this.manager.authMiddleware());
    // Register so the session module can force-disconnect users on logout.
    this.manager.registerServer(server);
    this.logger.log(`${this.constructor.name} initialised`);
  }

  async handleConnection(client: Socket): Promise<void> {
    const user = client.data.user as AuthenticatedUser | undefined;
    if (!user) {
      // Auth middleware should have set this; be defensive.
      client.disconnect(true);
      return;
    }
    const firstConnection = await this.manager.register(client);
    this.logger.debug(`socket connected: ${client.id} (user ${user.id})`);
    if (firstConnection) {
      this.server.emit('presence:online', { userId: user.id });
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const lastConnection = await this.manager.unregister(client);
    this.logger.debug(`socket disconnected: ${client.id}`);
    const user = client.data.user as AuthenticatedUser | undefined;
    if (lastConnection && user) {
      this.server.emit('presence:offline', { userId: user.id });
    }
  }

  @SubscribeMessage('room:join')
  @SubscribeMessage('join_room')
  async onRoomJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ): Promise<{ ok: boolean; roomId: string }> {
    // Namespace path (e.g. "/games") lets SocketManager consult a
    // per-namespace RoomJoinPolicy if one is registered; namespaces with no
    // policy join unconditionally, exactly as before this check existed.
    // `Server`'s public type omits `.name`, but Nest injects the namespace's
    // own `Namespace` object here (whose `.name` IS the path) — same cast
    // `SocketManager.serverForNamespace` already relies on.
    const namespace = (this.server as unknown as { name: string }).name;
    const ok = await this.manager.joinRoom(client, body.roomId, namespace);
    return { ok, roomId: body.roomId };
  }

  @SubscribeMessage('room:leave')
  @SubscribeMessage('leave_room')
  async onRoomLeave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ): Promise<{ ok: boolean; roomId: string }> {
    const namespace = (this.server as unknown as { name: string }).name;
    await this.manager.leaveRoom(client, body.roomId, namespace);
    return { ok: true, roomId: body.roomId };
  }

  @SubscribeMessage('room:stay_heartbeat')
  @SubscribeMessage('room:heartbeat')
  @SubscribeMessage('stay_heartbeat')
  async onRoomHeartbeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string },
  ): Promise<{ ok: boolean }> {
    if (body?.roomId) {
      await this.manager.heartbeatRoomStay(client, body.roomId);
    }
    return { ok: true };
  }

  /**
   * There is deliberately NO generic chat relay on this base class.
   *
   * A `send_chat` / `chat_message` / `send_message` handler used to live here and
   * echoed a client-supplied payload straight back to `server.to(roomId)`. It was
   * removed because it was a total bypass of every chat gate the platform owns:
   * it trusted `body.senderId` / `body.username` / `body.avatarUrl` (identity
   * spoofing), never checked room membership (so any authenticated socket could
   * inject into ANY room id, including one it had never joined), never consulted
   * mute/ban/block or chat mode, never touched `VideoRoomChatRateLimiter` or the
   * blocked-word scan, and persisted nothing — so the emitted payload carried no
   * message id, no server timestamp and no ordering, which made client-side
   * deduplication impossible.
   *
   * Durable room chat goes through the owning module's REST command
   * (`POST /video-rooms/:id/chat/messages` for VR-9), which runs policy → rate
   * limit → word scan → persist, and reaches clients as
   * `video_room.chat_message_sent` via that module's socket listener. Ephemeral
   * signals (typing, receipts) have their own authenticated gateway handlers.
   */

  /** Application-level liveness check (Socket.IO's own ping/pong is transport-level). */
  @SubscribeMessage('ping')
  onPing(): { pong: true; at: number } {
    return { pong: true, at: Date.now() };
  }

  /** Emit to every socket in a room (this namespace). */
  protected emitToRoom(room: string, event: string, payload: unknown): void {
    this.server.to(room).emit(event, payload);
  }

  /** Emit to all of a user's sockets across every instance. */
  protected emitToUser(userId: string, event: string, payload: unknown): void {
    this.manager.emitToUser(this.server, userId, event, payload);
  }
}
