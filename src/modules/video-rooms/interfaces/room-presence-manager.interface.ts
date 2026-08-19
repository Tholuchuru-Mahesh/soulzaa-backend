/**
 * Room presence manager for the audiences of a video room: seat holders
 * (participants / hosts), the audience (viewers), and incognito moderators —
 * tracked separately and excluded from every public count/list. Backed by
 * Redis sets so every API instance sees the same live counts. Pure presence
 * tracking — no business gating (capacity, permissions) lives here.
 */
export interface IRoomPresenceManager {
  addViewer(roomId: string, userId: string): Promise<void>;
  removeViewer(roomId: string, userId: string): Promise<void>;
  isViewer(roomId: string, userId: string): Promise<boolean>;
  viewerCount(roomId: string): Promise<number>;

  addHost(roomId: string, userId: string): Promise<void>;
  removeHost(roomId: string, userId: string): Promise<void>;
  isHost(roomId: string, userId: string): Promise<boolean>;
  hostCount(roomId: string): Promise<number>;

  addParticipant(roomId: string, userId: string): Promise<void>;
  removeParticipant(roomId: string, userId: string): Promise<void>;
  participantCount(roomId: string): Promise<number>;

  addModerator(roomId: string, userId: string): Promise<void>;
  removeModerator(roomId: string, userId: string): Promise<void>;
  isModeratorPresent(roomId: string, userId: string): Promise<boolean>;

  /** Drop all presence sets for a room (room ended/deleted). */
  clearRoom(roomId: string): Promise<void>;
}
