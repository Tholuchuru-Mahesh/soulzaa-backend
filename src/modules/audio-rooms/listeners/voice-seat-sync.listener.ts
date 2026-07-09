import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import {
  AUDIO_ROOM_SEAT_EVENTS,
  type SeatJoinedEvent,
  type SeatLeftEvent,
} from '../events/audio-room-seat.events';
import { VoiceService } from '../services/voice.service';

/**
 * Ties voice publish privilege to seat state: when a user takes or leaves a seat
 * (AR-1) their active voice session's role is re-evaluated (publisher on a seat,
 * subscriber in the audience) and a VoiceState event is emitted so the client
 * re-fetches a correctly-privileged ZEGO token. Newly-promoted speakers can talk
 * immediately; demoted ones stop publishing.
 */
@Injectable()
export class VoiceSeatSyncListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly voice: VoiceService,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<SeatJoinedEvent>(AUDIO_ROOM_SEAT_EVENTS.JOINED, (e) =>
      this.voice.syncRoleFromSeat(e.payload.roomId, e.payload.userId),
    );
    this.bus.subscribe<SeatLeftEvent>(AUDIO_ROOM_SEAT_EVENTS.LEFT, (e) =>
      this.voice.syncRoleFromSeat(e.payload.roomId, e.payload.userId),
    );
  }
}
