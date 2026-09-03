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
  /**
   * Human-readable template. `{name}` is substituted by
   * `VideoRoomSystemMessageService` with the subject's display name, resolved
   * from the event payload and falling back to the identity cache.
   *
   * This comment used to claim `{userId}` etc. were substituted "by the
   * service" while no substitution code existed anywhere — so every template
   * below was emitted verbatim. That is why rooms narrated themselves as
   * "A user joined the room." forever: there was no placeholder to fill and
   * nothing to fill it with.
   */
  template: string;
  /** Write a durable row. */
  persist: boolean;
  /** Degrade to broadcast-only above `videoRoomChat.systemMessageBroadcastOnlyAboveViewers`. */
  degradesWithRoomSize: boolean;
}

/**
 * Rendered in place of `{name}` when the subject cannot be resolved at all —
 * a deleted account, or a profile lookup that failed. Deliberately a neutral
 * word, never an invented name and never a dangling `{name}`.
 */
export const SYSTEM_MESSAGE_UNKNOWN_SUBJECT = 'Someone';

export const SYSTEM_MESSAGE_POLICY: Record<string, SystemMessagePolicy> = {
  // ---- Always persist: lifecycle, ownership, moderation, seat decisions ----
  ROOM_LOCKED: { template: 'The room was locked.', persist: true, degradesWithRoomSize: false },
  ROOM_UNLOCKED: { template: 'The room was unlocked.', persist: true, degradesWithRoomSize: false },
  ROOM_CLOSED: { template: 'The room has ended.', persist: false, degradesWithRoomSize: false },
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
    template: '{name} was invited to a seat.',
    persist: true,
    degradesWithRoomSize: false,
  },
  PROMOTED: {
    template: '{name} was promoted to the stage.',
    persist: true,
    degradesWithRoomSize: false,
  },
  DEMOTED: {
    template: '{name} was moved to the audience.',
    persist: true,
    degradesWithRoomSize: false,
  },

  // ---- Degrade with room size: presence churn ----
  USER_JOINED: {
    template: '{name} joined the room.',
    persist: true,
    degradesWithRoomSize: true,
  },
  USER_LEFT: { template: '{name} left the room.', persist: true, degradesWithRoomSize: true },
  VIEWER_JOINED: { template: '{name} joined.', persist: true, degradesWithRoomSize: true },
  VIEWER_LEFT: { template: '{name} left.', persist: true, degradesWithRoomSize: true },
};
