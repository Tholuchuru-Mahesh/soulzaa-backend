import type { PinnedMessage } from '@prisma/client';

/**
 * Public contract for the AR-4 room-chat layer — the cross-module read seam
 * (e.g. an admin portal or a room-snapshot composer) consumes without importing
 * internals. Message send/pin/delete happen through the chat REST controller.
 * A distinct token from the (unrelated) private-chat `CHAT_SERVICE` stub.
 */
export const AUDIO_ROOM_CHAT_SERVICE = Symbol('AUDIO_ROOM_CHAT_SERVICE');

export interface IAudioRoomChatService {
  /** Currently-pinned messages for a room (most recent first). */
  getActivePins(roomId: string): Promise<PinnedMessage[]>;

  /** True when the room's settings currently allow chat. */
  isChatEnabled(roomId: string): Promise<boolean>;
}
