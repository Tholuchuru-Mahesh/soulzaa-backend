/**
 * Public contract for the treasure-boxes module — the ONLY surface other modules
 * may depend on (this token/interface or the EVENT_BUS). Internals stay private.
 * Progress is driven by the gifts module's GiftSentEvent (consumed internally),
 * so the cross-module surface is a thin read seam.
 */
export const TREASURE_BOXES_SERVICE = Symbol('TREASURE_BOXES_SERVICE');

/** A live treasure-session snapshot for a room. */
export interface ActiveTreasureSession {
  sessionId: string;
  roomId: string;
  currentLevel: number;
  progress: number;
  threshold: number;
}

export interface ITreasureBoxesService {
  /** The room's active treasure session, or null. */
  getActiveSession(roomId: string): Promise<ActiveTreasureSession | null>;
}
