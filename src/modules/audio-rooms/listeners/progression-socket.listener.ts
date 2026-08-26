import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import {
  EXP_EVENTS,
  type RoomLeveledUpEvent,
  type UserLeveledUpEvent,
} from 'src/modules/exp/events/exp.events';
import { WEALTH_EVENTS, type WealthLevelUpEvent } from 'src/modules/wealth/events/wealth.events';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';

/**
 * Bridges AR-7 progression events to sockets. User level-ups and Wealth Level
 * up are delivered to the user across every namespace (so their client
 * refreshes badges/frames/entrance effects wherever they are); room
 * level-ups broadcast to the room. Consumes the exp/wealth modules only
 * through their published events.
 */
@Injectable()
export class ProgressionSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<UserLeveledUpEvent>(EXP_EVENTS.USER_LEVELED_UP, (e) =>
      this.sockets.emitToUserEverywhere(
        e.payload.userId,
        ROOM_SOCKET_EVENTS.USER_LEVEL_UP,
        e.payload,
      ),
    );
    this.bus.subscribe<RoomLeveledUpEvent>(EXP_EVENTS.ROOM_LEVELED_UP, (e) =>
      this.sockets.emitToNamespaceRoom(
        AUDIO_ROOM_NAMESPACE,
        e.payload.roomId,
        ROOM_SOCKET_EVENTS.ROOM_LEVEL_UP,
        e.payload,
      ),
    );
    this.bus.subscribe<WealthLevelUpEvent>(WEALTH_EVENTS.LEVEL_UP, (e) =>
      this.sockets.emitToUserEverywhere(
        e.payload.userId,
        ROOM_SOCKET_EVENTS.VIP_UPGRADED,
        e.payload,
      ),
    );
  }
}
