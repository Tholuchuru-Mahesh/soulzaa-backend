import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_EVENTS,
  type RoomDeletedEvent,
  type RoomEndedEvent,
} from '../events/audio-room.events';
import { VoiceService } from '../services/voice.service';

/**
 * Tears the voice layer down when a live ends, mirroring what
 * {@link AudioRoomSeatsListener} does for seats and roles — so AudioRoomsService
 * never has to depend on VoiceService (one-directional coupling).
 *
 * Without this a voice session survives ACTIVE past the end of the live, and
 * because sessions are unique on (room,user) and reactivated on rejoin, the next
 * session inherits the previous one's publisher role and self-mute flag.
 */
@Injectable()
export class VoiceLifecycleListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly voice: VoiceService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<RoomEndedEvent>(AUDIO_ROOM_EVENTS.ENDED, (e) =>
      this.voice.onRoomClosed(e.payload.roomId),
    );
    this.bus.subscribe<RoomDeletedEvent>(AUDIO_ROOM_EVENTS.DELETED, (e) =>
      this.voice.onRoomClosed(e.payload.roomId),
    );
  }
}
