import { DomainEvent } from 'src/common/events';

/**
 * Audio-room appearance events (AR-8). The room-cosmetics socket listener bridges
 * these to the `/audio-room` namespace so every participant re-renders the room's
 * theme/background and decorations in realtime.
 */
export const AUDIO_ROOM_APPEARANCE_EVENTS = {
  UPDATED: 'audio_room.appearance_updated',
} as const;

export class RoomAppearanceUpdatedEvent extends DomainEvent<{
  roomId: string;
  themeCosmeticId: string | null;
  themeName: string | null;
  decorationCosmeticIds: string[];
  decorationNames: string[];
  updatedBy: string;
}> {
  readonly name = AUDIO_ROOM_APPEARANCE_EVENTS.UPDATED;
}
