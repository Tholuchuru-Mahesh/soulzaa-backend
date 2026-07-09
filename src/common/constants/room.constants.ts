/** Room business constants (PRD Vol.2 — Audio/Video Rooms). */

/** One standard Audio Room per user (PRD business rule). */
export const MAX_STANDARD_ROOMS_PER_USER = 1;

/** Stage seat capacities. */
export const MAX_AUDIO_SEATS = 12;
export const MAX_VIDEO_SEATS = 9;

/** Role precedence for room moderation checks (higher wins). */
export const ROOM_ROLE_WEIGHT = {
  OWNER: 3,
  ADMIN: 2,
  SPEAKER: 1,
  LISTENER: 0,
} as const;
