import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { AUDIO_ROOM_NAMESPACE, ROOM_SOCKET_EVENTS } from '../constants/audio-room.constants';
import {
  AUDIO_ROOM_VOICE_EVENTS,
  type VoiceBackgroundEvent,
  type VoiceJoinedEvent,
  type VoiceLeftEvent,
  type VoiceMutedEvent,
  type VoiceQualityEvent,
  type VoiceReconnectedEvent,
  type VoiceRouteChangedEvent,
  type VoiceSpeakingChangedEvent,
  type VoiceStateEvent,
  type VoiceUnmutedEvent,
} from '../events/audio-room-voice.events';

/**
 * Bridges AR-2 voice domain events on the EVENT_BUS to realtime `voice.*`
 * broadcasts into the `/audio-room` namespace room (cross-instance via the Redis
 * adapter). Mirrors the room/seat socket listeners.
 */
@Injectable()
export class VoiceSocketListener implements OnModuleInit {
  constructor(
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    private readonly sockets: SocketManager,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe<VoiceJoinedEvent>(AUDIO_ROOM_VOICE_EVENTS.JOINED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_JOINED, e.payload),
    );
    this.bus.subscribe<VoiceLeftEvent>(AUDIO_ROOM_VOICE_EVENTS.LEFT, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_LEFT, e.payload),
    );
    this.bus.subscribe<VoiceMutedEvent>(AUDIO_ROOM_VOICE_EVENTS.MUTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_MUTED, e.payload),
    );
    this.bus.subscribe<VoiceUnmutedEvent>(AUDIO_ROOM_VOICE_EVENTS.UNMUTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_UNMUTED, e.payload),
    );
    this.bus.subscribe<VoiceSpeakingChangedEvent>(AUDIO_ROOM_VOICE_EVENTS.SPEAKING, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_SPEAKING, e.payload),
    );
    this.bus.subscribe<VoiceQualityEvent>(AUDIO_ROOM_VOICE_EVENTS.QUALITY, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_QUALITY, e.payload),
    );
    this.bus.subscribe<VoiceReconnectedEvent>(AUDIO_ROOM_VOICE_EVENTS.RECONNECTED, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_RECONNECTED, e.payload),
    );
    this.bus.subscribe<VoiceStateEvent>(AUDIO_ROOM_VOICE_EVENTS.STATE, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_STATE, e.payload),
    );
    this.bus.subscribe<VoiceRouteChangedEvent>(AUDIO_ROOM_VOICE_EVENTS.ROUTE, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_ROUTE, e.payload),
    );
    this.bus.subscribe<VoiceBackgroundEvent>(AUDIO_ROOM_VOICE_EVENTS.BACKGROUND, (e) =>
      this.emit(e.payload.roomId, ROOM_SOCKET_EVENTS.VOICE_BACKGROUND, e.payload),
    );
  }

  private emit(roomId: string, event: string, payload: unknown): void {
    this.sockets.emitToNamespaceRoom(AUDIO_ROOM_NAMESPACE, roomId, event, payload);
  }
}
