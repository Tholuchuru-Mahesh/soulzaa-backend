import { VideoRoomMessage } from '@prisma/client';
import type { ChatMessagePayload } from '../../events/video-room-chat.events';
import { ChatMessageStatus } from './chat-message.view';

/**
 * VR-9.2 (G2): the status the message view has always declared but nothing ever
 * computed. Derived from the row, never stored — a stored status would need a
 * write on every edit/delete/recall and could drift from the columns that are
 * already the source of truth.
 *
 * Order is load-bearing: a recall ALSO sets `deletedAt` (a recall is a delete
 * plus a tombstone), so RECALLED must be tested before DELETED or every recalled
 * message would report as merely deleted.
 */
export function deriveChatMessageStatus(message: VideoRoomMessage): ChatMessageStatus {
  if (message.recalledAt) return ChatMessageStatus.RECALLED;
  if (message.deletedAt) return ChatMessageStatus.DELETED;
  if (message.editedAt) return ChatMessageStatus.EDITED;
  return ChatMessageStatus.SENT;
}

/**
 * The ONE row→wire mapping. Previously duplicated byte-for-byte across
 * `VideoRoomChatService` and `VideoRoomChatQueryService`, which is how they were
 * able to drift; every payload change now happens here only.
 */
export function toChatMessagePayload(message: VideoRoomMessage): ChatMessagePayload {
  const metadata = (message.metadata ?? {}) as Record<string, unknown>;
  return {
    roomId: message.roomId,
    messageId: message.id,
    senderId: message.senderId,
    senderName: message.type === 'SYSTEM' ? 'System' : undefined,
    type: message.type,
    content: message.content,
    status: deriveChatMessageStatus(message),
    mentions: message.mentions,
    mentionScope: message.mentionScope,
    replyToId: message.replyToId,
    createdAt: message.createdAt.toISOString(),
    ...(typeof metadata.announcementId === 'string'
      ? { announcementId: metadata.announcementId }
      : {}),
    ...(typeof metadata.systemEvent === 'string' ? { systemEvent: metadata.systemEvent } : {}),
  };
}
