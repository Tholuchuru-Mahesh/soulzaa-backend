/**
 * What happens when a domain event becomes a system message.
 *
 * Persisting one message per join would make chat unusable in exactly the rooms
 * VR-9 was built for: a 10k-viewer room churning viewers writes more system rows
 * than human messages, buries real conversation, and leaves
 * `VideoRoomStatistics.totalChatMessages` measuring turnover rather than chat.
 *
 * So high-frequency, low-value events degrade with room size — broadcast-only
 * past one threshold, suppressed past a second — while lifecycle and moderation
 * events always persist no matter how large the room.
 */
export interface SystemMessagePolicy {
  /** Human-readable template; `{userId}` etc. are substituted by the service. */
  template: string;
  /** Write a durable row. */
  persist: boolean;
  /** Degrade to broadcast-only above `videoRoomChat.systemMessageBroadcastOnlyAboveViewers`. */
  degradesWithRoomSize: boolean;
}

export const SYSTEM_MESSAGE_POLICY: Record<string, SystemMessagePolicy> = {
  // ---- Always persist: lifecycle, ownership, moderation, seat decisions ----
  ROOM_LOCKED: { template: 'The room was locked.', persist: true, degradesWithRoomSize: false },
  ROOM_UNLOCKED: { template: 'The room was unlocked.', persist: true, degradesWithRoomSize: false },
  ROOM_CLOSED: { template: 'The room has ended.', persist: true, degradesWithRoomSize: false },
  OWNER_CHANGED: {
    template: 'Room ownership was transferred.',
    persist: true,
    degradesWithRoomSize: false,
  },
  SEAT_APPROVED: {
    template: 'A seat request was approved.',
    persist: true,
    degradesWithRoomSize: false,
  },
  SEAT_REJECTED: {
    template: 'A seat request was rejected.',
    persist: true,
    degradesWithRoomSize: false,
  },
  SEAT_INVITATION: {
    template: 'A user was invited to a seat.',
    persist: true,
    degradesWithRoomSize: false,
  },
  PROMOTED: {
    template: 'A viewer was promoted to the stage.',
    persist: true,
    degradesWithRoomSize: false,
  },
  DEMOTED: {
    template: 'A participant was moved to the audience.',
    persist: true,
    degradesWithRoomSize: false,
  },

  // ---- Degrade with room size: presence churn ----
  USER_JOINED: { template: 'A user joined the room.', persist: true, degradesWithRoomSize: true },
  USER_LEFT: { template: 'A user left the room.', persist: true, degradesWithRoomSize: true },
  VIEWER_JOINED: { template: 'A viewer joined.', persist: true, degradesWithRoomSize: true },
  VIEWER_LEFT: { template: 'A viewer left.', persist: true, degradesWithRoomSize: true },
};
