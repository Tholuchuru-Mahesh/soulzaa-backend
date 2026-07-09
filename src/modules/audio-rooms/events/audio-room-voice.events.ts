import { VoicePublishRole } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Audio-room voice events on the EVENT_BUS. The voice socket listener bridges
 * these to `voice.*` broadcasts in the `/audio-room` namespace; analytics
 * subscribes to the same events. `VoiceStateEvent` signals clients to re-fetch a
 * (re-privileged) token — e.g. after a seat change flips publisher/subscriber.
 */
export const AUDIO_ROOM_VOICE_EVENTS = {
  JOINED: 'audio_room.voice_joined',
  LEFT: 'audio_room.voice_left',
  MUTED: 'audio_room.voice_muted',
  UNMUTED: 'audio_room.voice_unmuted',
  SPEAKING: 'audio_room.voice_speaking',
  QUALITY: 'audio_room.voice_quality',
  RECONNECTED: 'audio_room.voice_reconnected',
  STATE: 'audio_room.voice_state',
  ROUTE: 'audio_room.voice_route',
  BACKGROUND: 'audio_room.voice_background',
} as const;

export class VoiceJoinedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  role: VoicePublishRole;
  participantCount: number;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.JOINED;
}

export class VoiceLeftEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  durationSeconds: number;
  reason: 'left' | 'timeout';
  participantCount: number;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.LEFT;
}

export class VoiceMutedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  selfMuted: boolean;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.MUTED;
}

export class VoiceUnmutedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  selfMuted: boolean;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.UNMUTED;
}

export class VoiceSpeakingChangedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  isSpeaking: boolean;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.SPEAKING;
}

export class VoiceQualityEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  qualityLevel: number;
  rttMs: number;
  packetLossPct: number;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.QUALITY;
}

export class VoiceReconnectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  reconnectCount: number;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.RECONNECTED;
}

export class VoiceStateEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  reason: 'role_changed';
  role: VoicePublishRole;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.STATE;
}

export class VoiceRouteChangedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  route: string;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.ROUTE;
}

export class VoiceBackgroundEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  inBackground: boolean;
}> {
  readonly name = AUDIO_ROOM_VOICE_EVENTS.BACKGROUND;
}
