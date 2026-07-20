/** One audience row surfaced by the viewer read model (VR-6). */
export interface ViewerSummaryView {
  userId: string;
}

export interface AudiencePage {
  items: ViewerSummaryView[];
  total: number;
}

/**
 * The audience seam (VR-6). Abstracts "who is watching, and how many" so the
 * durable (member-is-viewer) source can be swapped for a Redis-only,
 * broadcast-scale source later without touching the facade/controller. The
 * write methods are the presence contract the future ephemeral impl owns; in
 * durable mode the member lifecycle (VR-3) already performs the equivalent
 * writes on join/leave.
 */
export interface IViewerPresence {
  markPresent(roomId: string, userId: string): Promise<void>;
  markAbsent(roomId: string, userId: string): Promise<void>;
  isPresent(roomId: string, userId: string): Promise<boolean>;
  /** Audience = present members NOT occupying a seat. */
  audienceCount(roomId: string): Promise<number>;
  listAudience(roomId: string, take: number, skip: number): Promise<AudiencePage>;
}

export const VIEWER_PRESENCE = Symbol('VIEWER_PRESENCE');
