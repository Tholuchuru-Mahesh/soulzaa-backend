import type { AttachmentType, DirectMessageType, ReportReason } from '@prisma/client';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import type { SocialUserCard } from 'src/modules/social/interfaces/social.interface';
import type { TypingKind } from '../constants/chat.constants';

/**
 * Public contract for the chat module — the ONLY surface other modules may
 * depend on (this token, or the EVENT_BUS). Internals (repositories, DTOs,
 * concrete services) stay private. Notifications and analytics subscribe to
 * `chat.*` bus events rather than calling in here.
 */
export const CHAT_SERVICE = Symbol('CHAT_SERVICE');

/** Media attached to a message. Keys are resolved to URLs against the client's CDN base. */
export interface AttachmentView {
  id: string;
  type: AttachmentType;
  storageKey: string;
  thumbnailKey: string | null;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  waveform: number[];
  filename: string | null;
}

/** Reactions on a message, collapsed per emoji (never one entry per reactor). */
export interface ReactionView {
  emoji: string;
  count: number;
  /** Whether the requesting user is one of the reactors. */
  reactedByMe: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  type: DirectMessageType;
  content: string;
  /** Echoed back so an optimistic client can reconcile its pending copy. */
  clientId: string;
  replyToId: string | null;
  attachments: AttachmentView[];
  reactions: ReactionView[];
  /** Payload for the rich types (GIFT / PROFILE_SHARE / ROOM_INVITE / CALL_LOG). */
  metadata: Record<string, unknown> | null;
  isDeleted: boolean;
  editedAt: Date | null;
  createdAt: Date;
}

/**
 * Delivery state is derived from the peer's watermarks, never stored per
 * message: SENT once persisted, DELIVERED once the peer's delivered-watermark
 * covers it, READ once their read-watermark does.
 */
export type MessageDeliveryState = 'SENT' | 'DELIVERED' | 'READ';

/** The requesting user's own state in a conversation. */
export interface ConversationSelfView {
  unreadCount: number;
  isPinned: boolean;
  isArchived: boolean;
  isFavorite: boolean;
  isMuted: boolean;
  mutedUntil: Date | null;
  draft: string | null;
  lastReadMessageId: string | null;
  /** The user pressed "mark unread"; the badge shows even though they did read it. */
  manualUnread: boolean;
}

/** The peer's read/delivery watermarks — what drives the sender's ticks. */
export interface ConversationPeerView {
  lastReadMessageAt: Date | null;
  lastDeliveredMessageAt: Date | null;
}

export interface ConversationView {
  id: string;
  /** The other participant. A DIRECT conversation always has exactly one. */
  peer: SocialUserCard;
  lastMessage: MessageView | null;
  self: ConversationSelfView;
  peerState: ConversationPeerView;
  /** True while this is a chat request the *requesting user* must accept. */
  isRequest: boolean;
  /** True while this is a request the requesting user sent, still unaccepted. */
  isPendingOutbound: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface UnreadTotalView {
  /** Unread messages across all accepted, non-archived conversations. */
  total: number;
  /** Conversations carrying at least one unread message. */
  conversations: number;
  /** Pending inbound chat requests. */
  requests: number;
}

export interface AttachmentInput {
  type: AttachmentType;
  storageKey: string;
  thumbnailKey?: string;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  width?: number;
  height?: number;
  waveform?: number[];
  filename?: string;
}

export interface SendMessageInput {
  clientId: string;
  type: DirectMessageType;
  content: string;
  replyToId?: string;
  attachments?: AttachmentInput[];
  metadata?: Record<string, unknown>;
}

export type ConversationFilter =
  'INBOX' | 'FRIENDS' | 'UNREAD' | 'REQUESTS' | 'ARCHIVED' | 'FAVORITES' | 'BLOCKED';

export interface ListConversationsInput {
  page: number;
  limit: number;
  filter: ConversationFilter;
  search?: string;
  /** Keyset cursor: the last conversation id from the previous page. */
  cursor?: string;
}

export interface ConversationSettingsInput {
  isPinned?: boolean;
  isArchived?: boolean;
  isFavorite?: boolean;
  isMuted?: boolean;
  mutedUntil?: Date | null;
}

/** Per-category badge counts for the Chats screen's category chips. */
export interface CategoryCountsView {
  all: number;
  friends: number;
  unread: number;
  requests: number;
  archived: number;
  favorites: number;
  blocked: number;
}

export interface IChatService {
  // ---- Conversations ----
  openDirect(userId: string, peerUserId: string): Promise<ConversationView>;
  getConversation(userId: string, conversationId: string): Promise<ConversationView>;
  listConversations(
    userId: string,
    input: ListConversationsInput,
  ): Promise<Paginated<ConversationView>>;
  updateSettings(
    userId: string,
    conversationId: string,
    input: ConversationSettingsInput,
  ): Promise<ConversationView>;
  saveDraft(userId: string, conversationId: string, text: string | null): Promise<void>;
  clearHistory(userId: string, conversationId: string): Promise<void>;
  categoryCounts(userId: string): Promise<CategoryCountsView>;

  // ---- Chat requests ----
  acceptRequest(userId: string, conversationId: string): Promise<ConversationView>;
  declineRequest(userId: string, conversationId: string): Promise<void>;

  // ---- Messages ----
  sendMessage(
    userId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessageView>;
  history(
    userId: string,
    conversationId: string,
    opts: { page: number; limit: number; before?: string },
  ): Promise<Paginated<MessageView>>;
  deleteMessage(userId: string, messageId: string): Promise<void>;
  editMessage(userId: string, messageId: string, content: string): Promise<MessageView>;
  react(userId: string, messageId: string, emoji: string): Promise<void>;
  unreact(userId: string, messageId: string, emoji: string): Promise<void>;
  report(
    userId: string,
    conversationId: string,
    input: { reason: ReportReason; messageId?: string; description?: string },
  ): Promise<{ reportId: string }>;

  // ---- Receipts & indicators ----
  markRead(userId: string, conversationId: string, messageId: string): Promise<void>;
  /** Restore the unread badge without rewinding the read receipt the peer already saw. */
  markUnread(userId: string, conversationId: string): Promise<void>;
  markDelivered(userId: string, conversationId: string, messageId: string): Promise<void>;
  typing(
    userId: string,
    conversationId: string,
    isTyping: boolean,
    kind: TypingKind,
  ): Promise<void>;

  // ---- Badge ----
  unreadTotal(userId: string): Promise<UnreadTotalView>;
}
