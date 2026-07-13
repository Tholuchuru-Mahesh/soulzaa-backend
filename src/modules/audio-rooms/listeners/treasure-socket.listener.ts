import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  TREASURE_EVENTS,
  type RocketCompletedEvent,
  type RocketProgressEvent,
  type RocketStartedEvent,
  type TreasureBoxOpenedEvent,
  type TreasureProgressEvent,
  type TreasureSessionCompletedEvent,
  type TreasureSessionStartedEvent,
  type TreasureReceiverRewardEvent,
  type ContributionCounterUpdatedEvent,
} from 'src/modules/treasure-boxes/events/treasure.events';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

/**
 * Bridges AR-6 treasure box & rocket events to the audio-room sockets so every
 * participant sees live progress bars, box-opening animations with the Top-3
 * winners, global room announcements, and rocket celebrations. Consumes the
 * treasure-boxes module only through its published events, keeping the
 * `/audio-room` namespace constant inside the audio-rooms module.
 */
@Injectable()
export class TreasureSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<TreasureSessionStartedEvent>(TREASURE_EVENTS.SESSION_STARTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.TREASURE_STARTED, e.payload),
    );
    this.bus.subscribe<TreasureProgressEvent>(TREASURE_EVENTS.PROGRESS, (e) => {
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.TREASURE_PROGRESS, e.payload);
      // Emit the alternate name requested by user
      this.room(e.payload.roomId, 'treasure_progress_update', e.payload);
    });
    this.bus.subscribe<TreasureBoxOpenedEvent>(TREASURE_EVENTS.BOX_OPENED, (e) => {
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.TREASURE_OPENED, e.payload);
      // Emit the alternate names requested by user
      this.room(e.payload.roomId, 'treasure_box_unlocked', e.payload);
      this.room(e.payload.roomId, 'treasure_top_contributors', {
        roomId: e.payload.roomId,
        boxId: e.payload.sessionId,
        level: e.payload.level,
        topGifters: e.payload.topGifters,
      });
      this.room(e.payload.roomId, 'treasure_reward_distributed', {
        roomId: e.payload.roomId,
        boxId: e.payload.sessionId,
        level: e.payload.level,
        rewards: e.payload.rewards,
      });
    });
    this.bus.subscribe<TreasureSessionCompletedEvent>(TREASURE_EVENTS.SESSION_COMPLETED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.TREASURE_COMPLETED, e.payload),
    );
    this.bus.subscribe<TreasureReceiverRewardEvent>(TREASURE_EVENTS.RECEIVER_REWARD, (e) =>
      this.room(e.payload.roomId, 'treasure_receiver_reward', e.payload),
    );
    this.bus.subscribe<ContributionCounterUpdatedEvent>(TREASURE_EVENTS.CONTRIBUTION_COUNTER_UPDATED, (e) =>
      this.room(e.payload.roomId, 'contribution_counter_updated', e.payload),
    );
    this.bus.subscribe<RocketStartedEvent>(TREASURE_EVENTS.ROCKET_STARTED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.ROCKET_STARTED, e.payload),
    );
    this.bus.subscribe<RocketProgressEvent>(TREASURE_EVENTS.ROCKET_PROGRESS, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.ROCKET_PROGRESS, e.payload),
    );
    this.bus.subscribe<RocketCompletedEvent>(TREASURE_EVENTS.ROCKET_COMPLETED, (e) =>
      this.room(e.payload.roomId, ROOM_SOCKET_EVENTS.ROCKET_COMPLETED, e.payload),
    );
  }

  private room(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
