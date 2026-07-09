import type { VoiceStateSnapshot } from '../repositories/voice-session.repository';

/**
 * Public contract for the AR-2 voice layer — the cross-module read seam other
 * domains (gifts, PK, moderation) consume without importing audio-rooms
 * internals. Mutations happen through the REST controller / EVENT_BUS reactions.
 */
export const VOICE_SERVICE = Symbol('VOICE_SERVICE');

export interface IVoiceService {
  /** True when the user currently has an active voice session in the room. */
  isInVoice(roomId: string, userId: string): Promise<boolean>;

  /** True when the user has self-muted their microphone. */
  isSelfMuted(roomId: string, userId: string): Promise<boolean>;

  /** User ids currently speaking (active-speaker indicators). */
  activeSpeakers(roomId: string): Promise<string[]>;

  /** Full live voice state (participants + roles + mute/speaking/quality). */
  getVoiceState(roomId: string): Promise<VoiceStateSnapshot>;
}
