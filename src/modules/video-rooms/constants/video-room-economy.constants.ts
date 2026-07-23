/**
 * Room-contextual economy socket events (VR-14). Emitted into the `/video-room`
 * namespace + to the affected user. Distinct from the personal wallet events,
 * which the wallet module owns.
 */
export const VIDEO_ROOM_ECONOMY_SOCKET_EVENTS = {
  REWARD_RECEIVED: 'rewardReceived',
  HOST_EARNING_UPDATED: 'hostEarningUpdated',
  TRANSACTION_FAILED: 'transactionFailed',
} as const;

/**
 * Application-layer economy failure event on the EVENT_BUS. Published by the
 * failing operation (e.g. gift send catching INSUFFICIENT_BALANCE), bridged to
 * the `transactionFailed` socket event by VideoRoomEconomySocketListener. This is
 * NOT a wallet-domain event: a failed wallet movement rolls back and produces no
 * wallet transaction and no wallet event, so there is nothing on the wallet bus
 * to observe.
 */
export const VIDEO_ROOM_ECONOMY_EVENTS = {
  GIFT_FAILED: 'video_room.economy.gift_failed',
} as const;
