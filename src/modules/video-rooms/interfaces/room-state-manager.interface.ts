import type { VideoRoomStatus } from '@prisma/client';

/**
 * Versioned live room-state snapshot held in Redis. `version` increments on
 * every applied update so concurrent writers detect conflicts (optimistic
 * concurrency) and clients can reconcile out-of-order `state_sync` events.
 */
export interface VideoRoomStateSnapshot {
  roomId: string;
  version: number;
  status: VideoRoomStatus;
  participantCount: number;
  viewerCount: number;
  hostCount: number;
  /** Members with a live session in ONLINE/IDLE state (VR-3). */
  onlineCount: number;
  /** Members currently RECONNECTING/DISCONNECTED within the grace window (VR-3). */
  reconnectingCount: number;
  /** Members whose session is IDLE (backgrounded/inactive) (VR-3). */
  idleCount: number;
  isLocked: boolean;
  updatedAt: string;
}

/** The mutable subset an update may change (roomId/version/updatedAt are managed). */
export type VideoRoomStateMutation = Partial<
  Omit<VideoRoomStateSnapshot, 'roomId' | 'version' | 'updatedAt'>
>;

/**
 * Centralised room-state manager: versioned snapshots, conflict-safe updates
 * under a distributed lock, and recovery/rebuild from the durable tables.
 */
export interface IRoomStateManager {
  /** Current snapshot, or null if none is cached. */
  getSnapshot(roomId: string): Promise<VideoRoomStateSnapshot | null>;

  /**
   * Apply a versioned update under the room's state lock. `mutate` receives the
   * current snapshot and returns the fields to change; the manager merges them,
   * bumps `version`, and persists the result. Resolves to the new snapshot.
   */
  applyUpdate(
    roomId: string,
    mutate: (current: VideoRoomStateSnapshot) => VideoRoomStateMutation,
  ): Promise<VideoRoomStateSnapshot>;

  /** Rebuild the snapshot from the durable record (recovery); null if the room is gone. */
  restore(roomId: string): Promise<VideoRoomStateSnapshot | null>;

  /** Drop the cached snapshot (room ended/deleted). */
  clear(roomId: string): Promise<void>;
}
