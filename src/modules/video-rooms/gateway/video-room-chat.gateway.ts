import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { VIDEO_ROOM_CHAT_INBOUND_EVENTS } from '../constants/video-room.constants';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatReceiptService } from '../services/video-room-chat-receipt.service';
import { VideoRoomTypingService } from '../services/video-room-typing.service';

interface TypingPayload {
  roomId?: string;
}
interface ReceiptPayload {
  roomId?: string;
  messageId?: string;
}

/**
 * Inbound chat socket handlers — EPHEMERAL SIGNALS ONLY. Durable commands (send,
 * edit, delete, pin, announce) go over REST, where they are auditable and
 * idempotent; typing pings and receipts come here because an HTTP round trip per
 * keystroke is pure waste at scale.
 *
 * This is a transport adapter with no logic of its own: it resolves the actor
 * from the authenticated socket and delegates to the same services the REST
 * controller uses. Every handler is fail-soft — a rejected typing ping must
 * never tear down a live video connection, so failures are logged, not thrown.
 */
@Injectable()
@WebSocketGateway({ namespace: SOCKET_NAMESPACES.VIDEO_ROOM })
export class VideoRoomChatGateway {
  private readonly logger = new Logger(VideoRoomChatGateway.name);

  constructor(
    private readonly typing: VideoRoomTypingService,
    private readonly receipts: VideoRoomChatReceiptService,
  ) {}

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.TYPING_START)
  async typingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TypingPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId) return;
    await this.guard(() => this.typing.start(actor, body.roomId as string));
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.TYPING_STOP)
  async typingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: TypingPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId) return;
    await this.guard(() => this.typing.stop(actor, body.roomId as string));
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.MESSAGE_DELIVERED)
  async messageDelivered(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ReceiptPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId || !body?.messageId) return;
    await this.guard(() =>
      this.receipts.markDelivered(actor, body.roomId as string, body.messageId as string),
    );
  }

  @SubscribeMessage(VIDEO_ROOM_CHAT_INBOUND_EVENTS.MESSAGE_READ)
  async messageRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ReceiptPayload,
  ): Promise<void> {
    const actor = this.actor(client);
    if (!actor || !body?.roomId || !body?.messageId) return;
    await this.guard(() =>
      this.receipts.markRead(actor, body.roomId as string, body.messageId as string),
    );
  }

  private actor(client: Socket): RoomActor | null {
    const user = (client.data as { user?: RoomActor } | undefined)?.user;
    return user?.id ? { id: user.id, roles: user.roles ?? [] } : null;
  }

  /** Fail-soft: an ephemeral signal is never worth dropping the connection. */
  private async guard(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.debug(`Chat socket signal ignored: ${(error as Error).message}`);
    }
  }
}
