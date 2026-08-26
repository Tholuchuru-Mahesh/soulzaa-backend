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

  @SubscribeMessage('send_chat')
  @SubscribeMessage('chat_message')
  @SubscribeMessage('send_message')
  async onChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { roomId: string; message?: string; text?: string },
  ): Promise<{ ok: boolean }> {
    const user = client.data.user as AuthenticatedUser | undefined;
    const text = (body.message ?? body.text ?? '').trim();
    if (!text || !body.roomId) return { ok: false };

    const payload = {
      roomId: body.roomId,
      senderId: user?.id ?? 'user',
      username: user?.username ?? user?.name ?? 'User',
      avatarUrl: user?.avatarUrl,
      text: text,
      timestamp: new Date().toISOString(),
    };

    this.server.to(body.roomId).emit('chat:message', payload);
    this.server.to(body.roomId).emit('video_room:chat_message', payload);
    this.server.to(body.roomId).emit('video_room.chat_message_sent', payload);
    return { ok: true };
  }

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
