import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BackpackItemType } from '@prisma/client';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  BACKPACK_SERVICE,
  type IBackpackService,
} from 'src/modules/backpack/interfaces/backpack.service.interface';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_APPEARANCE_EVENTS,
  type RoomAppearanceUpdatedEvent,
} from '../events/audio-room-appearance.events';
import { AUDIO_ROOM_EVENTS, type RoomJoinedEvent } from '../events/audio-room.events';

/**
 * Bridges AR-8 backpack cosmetics to the audio-room sockets:
 *  - Room appearance changes (theme/decorations) broadcast so every client
 *    re-renders the room.
 *  - On room join, the joiner's equipped ENTRANCE_EFFECT (resolved via the
 *    backpack) is broadcast so every client plays the entrance animation.
 * Consumes the backpack only through its public service token.
 */
@Injectable()
export class RoomCosmeticsSocketListener implements OnModuleInit {
  private readonly logger = new Logger(RoomCosmeticsSocketListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
    @Inject(BACKPACK_SERVICE) private readonly backpack: IBackpackService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomAppearanceUpdatedEvent>(AUDIO_ROOM_APPEARANCE_EVENTS.UPDATED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.ROOM_APPEARANCE, e.payload),
    );
    this.bus.subscribe<RoomJoinedEvent>(AUDIO_ROOM_EVENTS.JOINED, (e) => void this.onJoin(e));
  }

  private async onJoin(e: RoomJoinedEvent): Promise<void> {
    const { roomId, userId } = e.payload;
    try {
      const equipped = await this.backpack.getEquipped(userId, BackpackItemType.ENTRANCE_EFFECT);
      if (!equipped) return;
      this.room(roomId, ROOM_SOCKET_EVENTS.ROOM_ENTRANCE_EFFECT, {
        roomId,
        userId,
        cosmeticId: equipped.cosmeticId,
        name: equipped.name,
      });
    } catch (err) {
      this.logger.warn(`Entrance effect broadcast failed: ${(err as Error).message}`);
    }
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
