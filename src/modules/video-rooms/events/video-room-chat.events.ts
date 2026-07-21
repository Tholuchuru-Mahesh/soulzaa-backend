import { DomainEvent } from 'src/common/events';
import type { ChatMessageStatus } from '../dto/chat/chat-message.view';

/**
 * VR-9 chat domain events on the EVENT_BUS. `VideoRoomChatSocketListener` bridges
 * these to `video_room.chat_*` broadcasts; the metrics and audit listeners
 * subscribe to the same names. Downstream domains may subscribe without importing
 * this module. Chat services never touch sockets, Prometheus or the audit store
 * directly — they publish here.
 */
export const VIDEO_ROOM_CHAT_EVENTS = {
  MESSAGE_SENT: 'video_room.chat_message_sent',
  MESSAGE_EDITED: 'video_room.chat_message_edited',
  MESSAGE_DELETED: 'video_room.chat_message_deleted',
  MESSAGE_RECALLED: 'video_room.chat_message_recalled',
  MESSAGE_PINNED: 'video_room.chat_message_pinned',
  MESSAGE_UNPINNED: 'video_room.chat_message_unpinned',
  ANNOUNCEMENT_CREATED: 'video_room.chat_announcement_created',
  ANNOUNCEMENT_UPDATED: 'video_room.chat_announcement_updated',
  ANNOUNCEMENT_DELETED: 'video_room.chat_announcement_deleted',
  TYPING_STARTED: 'video_room.chat_typing_started',
  TYPING_STOPPED: 'video_room.chat_typing_stopped',
  MESSAGE_DELIVERED: 'video_room.chat_message_delivered',
  MESSAGE_READ: 'video_room.chat_message_read',
  MENTIONED: 'video_room.chat_mentioned',
  CHAT_MODE_CHANGED: 'video_room.chat_mode_changed',
  SPAM_DETECTED: 'video_room.chat_spam_detected',
} as const;

/** The wire shape of a message, shared by every message-carrying event. */
export interface ChatMessagePayload {
  roomId: string;
  messageId: string;
  senderId: string;
  type: string;
  content: string;
  /**
   * Derived at read time from the row's editedAt/deletedAt/recalledAt columns —
   * never stored. SENDING/FAILED are client-only; DELIVERED/READ are
   * per-recipient facts resolved from the cursor endpoints.
   */
  status: ChatMessageStatus;
  mentions: string[];
  mentionScope: string | null;
  replyToId: string | null;
  createdAt: string;
  /** Present only on ANNOUNCEMENT projections. */
  announcementId?: string;
  /** Present only on SYSTEM rows — the domain event that produced it. */
  systemEvent?: string;
}

/** Per-request audit context threaded from the controller onto every event. */
export interface ChatAuditContext {
  ip?: string;
  requestId?: string;
  userAgent?: string;
}

export class ChatMessageSentEvent extends DomainEvent<
  ChatMessagePayload & { audit?: ChatAuditContext }
> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT;
}

export class ChatMessageEditedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  editorId: string;
  content: string;
  editedAt: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_EDITED;
}

export class ChatMessageDeletedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  deletedBy: string;
  /** True when a moderator deleted someone else's message. */
  byModerator: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELETED;
}

export class ChatMessageRecalledEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  senderId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_RECALLED;
}

export class ChatMessagePinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  pinnedBy: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_PINNED;
}

export class ChatMessageUnpinnedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  unpinnedBy: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_UNPINNED;
}

export class ChatAnnouncementCreatedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string;
  authorId: string;
  content: string;
  isPinned: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_CREATED;
}

export class ChatAnnouncementUpdatedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string | null;
  actorId: string;
  content: string;
  isPinned: boolean;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_UPDATED;
}

export class ChatAnnouncementDeletedEvent extends DomainEvent<{
  roomId: string;
  announcementId: string;
  messageId: string | null;
  actorId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.ANNOUNCEMENT_DELETED;
}

export class ChatTypingStartedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.TYPING_STARTED;
}

export class ChatTypingStoppedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.TYPING_STOPPED;
}

export class ChatMessageDeliveredEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  messageId: string;
  at: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_DELIVERED;
}

export class ChatMessageReadEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  messageId: string;
  at: string;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MESSAGE_READ;
}

export class ChatMentionedEvent extends DomainEvent<{
  roomId: string;
  messageId: string;
  senderId: string;
  recipientIds: string[];
  scope: string | null;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.MENTIONED;
}

/**
 * VR-9.1a: fired by `VideoRoomChatSettingsService` whenever `chatMode`,
 * `allowChat` or `slowModeSeconds` change, so clients can grey out the composer
 * without refetching the whole settings payload.
 */
export class ChatModeChangedEvent extends DomainEvent<{
  roomId: string;
  chatMode: string;
  allowChat: boolean;
  slowModeSeconds: number;
  actorId: string;
  audit?: ChatAuditContext;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED;
}

/**
 * The closed set of abuse signals. A union rather than a bare string so a typo
 * cannot silently mint a new Prometheus label value and fragment the metric.
 *
 * Slow mode is deliberately ABSENT: it is a room-level UX setting, and a user
 * hitting it is complying with room policy, not abusing it.
 */
export type ChatSpamKind = 'cooldown' | 'rate' | 'flood' | 'duplicate' | 'blocked_word';

/**
 * VR-9.2 (G3): published at every abuse rejection so
 * `VideoRoomChatMetricsListener` can count it. Internal only — this must NEVER
 * be bridged to a socket broadcast, because it would leak moderation signal to
 * the room.
 */
export class ChatSpamDetectedEvent extends DomainEvent<{
  roomId: string;
  userId: string;
  kind: ChatSpamKind;
}> {
  readonly name = VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED;
}
