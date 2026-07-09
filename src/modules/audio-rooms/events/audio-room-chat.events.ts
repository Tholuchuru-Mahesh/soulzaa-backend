import { ChatMessageType, ReportReason } from '@prisma/client';
import { DomainEvent } from 'src/common/events';

/**
 * Audio-room chat events on the EVENT_BUS (AR-4). The chat socket listener
 * bridges room-facing ones (message/typing/pin/delete/react/announcement) to
 * `chat.*` broadcasts on the `/audio-room` namespace; mention and report events
 * are delivered only to their recipients. Analytics/notifications subscribe to
 * the same events without importing this module.
 */
export const AUDIO_ROOM_CHAT_EVENTS = {
  MESSAGE_SENT: 'audio_room.chat_message_sent',
  MESSAGE_DELETED: 'audio_room.chat_message_deleted',
  MESSAGE_PINNED: 'audio_room.chat_message_pinned',
  MESSAGE_UNPINNED: 'audio_room.chat_message_unpinned',
  REACTION: 'audio_room.chat_reaction',
  TYPING: 'audio_room.chat_typing',
  ANNOUNCEMENT: 'audio_room.chat_announcement',
  MENTION: 'audio_room.chat_mention',
  REPORTED: 'audio_room.chat_reported',
} as const;

export interface ChatMessagePayload {
  id: string;
  roomId: string;
  senderId: string;
  type: ChatMessageType;
  content: string;
  gifUrl: string | null;
  mentions: string[];
  replyToId: string | null;
  createdAt: string;
}

export class ChatMessageSentEvent extends DomainEvent<ChatMessagePayload> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.MESSAGE_SENT;
}

export class ChatMessageDeletedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  deletedBy: string;
  byModerator: boolean;
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.MESSAGE_DELETED;
}

export class ChatMessagePinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  pinnedBy: string;
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.MESSAGE_PINNED;
}

export class ChatMessageUnpinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  unpinnedBy: string;
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED;
}

export class ChatReactionEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  emoji: string;
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.REACTION;
}

export class ChatTypingEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  isTyping: boolean;
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.TYPING;
}

export class ChatAnnouncementEvent extends DomainEvent<ChatMessagePayload> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.ANNOUNCEMENT;
}

export class ChatMentionEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  senderId: string;
  recipientIds: string[];
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.MENTION;
}

export class ChatReportedEvent extends DomainEvent<{
  roomId: string;
  reportId: string;
  messageId: string;
  reporterId: string;
  targetUserId: string;
  reason: ReportReason;
  /** Owner + room admins who should be notified of the report. */
  recipientIds: string[];
}> {
  readonly name = AUDIO_ROOM_CHAT_EVENTS.REPORTED;
}
