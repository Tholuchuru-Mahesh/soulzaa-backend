import { DomainEvent } from 'src/common/events';

/**
 * EXP/level domain events on the EVENT_BUS. Level-ups are delivered to the user
 * (and room level-ups broadcast to the room) by the audio-rooms socket bridge;
 * notifications/analytics consume the same events.
 */
export const EXP_EVENTS = {
  USER_LEVELED_UP: 'exp.user_leveled_up',
  ROOM_LEVELED_UP: 'exp.room_leveled_up',
} as const;

/** A reward that was granted on level-up (for the notification payload). */
export interface LevelRewardSummary {
  kind: string;
  coins: number | null;
  currency: string | null;
  cosmeticId: string | null;
}

export class UserLeveledUpEvent extends DomainEvent<{
  userId: string;
  fromLevel: number;
  toLevel: number;
  totalExp: number;
  rewards: LevelRewardSummary[];
}> {
  readonly name = EXP_EVENTS.USER_LEVELED_UP;
}

export class RoomLeveledUpEvent extends DomainEvent<{
  roomId: string;
  fromLevel: number;
  toLevel: number;
  totalExp: number;
}> {
  readonly name = EXP_EVENTS.ROOM_LEVELED_UP;
}
