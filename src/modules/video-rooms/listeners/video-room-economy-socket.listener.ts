// src/modules/video-rooms/listeners/video-room-economy-socket.listener.ts
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { GiftContextType } from '@prisma/client';
import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { GIFT_EVENTS, type GiftSentEvent } from 'src/modules/gifts/events/gift.events';
import {
  VIDEO_ROOM_ECONOMY_EVENTS,
  VIDEO_ROOM_ECONOMY_SOCKET_EVENTS,
} from '../constants/video-room-economy.constants';
import { VideoRoomEconomyFailedEvent } from '../events/video-room-economy.events';
import {
  VIDEO_ROOM_TREASURE_EVENTS,
  type TreasureRewardDistributedEvent,
} from '../events/video-room-treasure.events';
import {
  VIDEO_ROOM_PK_EVENTS,
  type PkRewardDistributedEvent,
} from '../events/video-room-pk.events';

/**
 * Room-contextual economy → socket bridge (VR-14). Subscribes to events the
 * engines ALREADY emit and maps them to room-facing socket events. Does no wallet
 * work. Mirrors the audio-room GiftSocketListener seam: the `/video-room`
 * namespace constant stays in this module; the gifts module is consumed only via
 * its published events.
 */
@Injectable()
export class VideoRoomEconomySocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    // Host earnings — only VIDEO_ROOM gifts are ours (contextType is shared).
    this.bus.subscribe<GiftSentEvent>(GIFT_EVENTS.SENT, (e) => {
      const p = e.payload;
      if (p.contextType !== GiftContextType.VIDEO_ROOM) return;
      const payload = {
        roomId: p.contextId,
        hostId: p.receiverId,
        transactionId: p.transactionId,
        earnings: p.creatorEarnings,
      };
      this.room(p.contextId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED, payload);
      this.sockets.emitToUserEverywhere(
        p.receiverId,
        VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.HOST_EARNING_UPDATED,
        payload,
      );
    });

    // Treasure reward — one payload per recipient.
    this.bus.subscribe<TreasureRewardDistributedEvent>(
      VIDEO_ROOM_TREASURE_EVENTS.REWARD_DISTRIBUTED,
      (e) => {
        const p = e.payload;
        const payload = {
          source: 'TREASURE',
          roomId: p.roomId,
          userId: p.userId,
          amount: p.amount,
        };
        this.sockets.emitToUserEverywhere(
          p.userId,
          VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED,
          payload,
        );
        this.room(p.roomId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
      },
    );

    // PK reward — payload carries an array of recipients.
    this.bus.subscribe<PkRewardDistributedEvent>(VIDEO_ROOM_PK_EVENTS.REWARD_DISTRIBUTED, (e) => {
      const p = e.payload;
      for (const r of p.rewards) {
        const payload = {
          source: 'PK',
          roomId: p.roomId,
          battleId: p.battleId,
          userId: r.userId,
          kind: r.kind,
          amount: r.amount,
        };
        this.sockets.emitToUserEverywhere(
          r.userId,
          VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED,
          payload,
        );
        this.room(p.roomId, VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.REWARD_RECEIVED, payload);
      }
    });

    // transactionFailed — app-layer, from the failing operation (not the wallet bus).
    this.bus.subscribe<VideoRoomEconomyFailedEvent>(VIDEO_ROOM_ECONOMY_EVENTS.GIFT_FAILED, (e) => {
      const p = e.payload;
      this.sockets.emitToUserEverywhere(
        p.userId,
        VIDEO_ROOM_ECONOMY_SOCKET_EVENTS.TRANSACTION_FAILED,
        {
          roomId: p.roomId,
          giftId: p.giftId,
          errorCode: p.errorCode,
          message: p.message,
        },
      );
    });
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(SOCKET_NAMESPACES.VIDEO_ROOM, roomId, event, payload);
  }
}
