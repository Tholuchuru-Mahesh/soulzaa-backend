/** Roles within an audio/video room (see ROOM_ROLE_WEIGHT for precedence). */
export enum RoomRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  SPEAKER = 'SPEAKER',
  LISTENER = 'LISTENER',
}
