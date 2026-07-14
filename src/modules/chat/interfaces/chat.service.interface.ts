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

/**
 * Media attached to a message.
 *
 * `url` and `thumbnailUrl` are resolved **server-side**, and that is a deliberate
 * authorisation decision rather than a convenience. `GET /storage/download-url`
 * authorises by key *ownership* — it would refuse to serve a user their peer's
 * image, which is every inbound attachment in every conversation. Resolving here
 * means access is granted by conversation participation, which is the right
 * question to ask, and a page of thirty images costs no extra round trips.
 *
 * The keys are still sent: they are what a message references, and what a delete
 * names. The URLs are how the media is *fetched*, and they may be short-lived
 * presigned GETs when no public CDN base is configured.
 */
export interface AttachmentView {
  id: string;
  type: AttachmentType;
  storageKey: string;
  thumbnailKey: string | null;
  url: string | null;
  thumbnailUrl: string | null;
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

/**
 * Open Graph metadata for the first link in a message body.
 *
 * `PENDING` while the crawler is still working and `FAILED` when it gave up —
 * both are reported honestly rather than being flattened to null, so a client can
 * tell "no preview yet" from "this link has no preview".
 */
export interface LinkPreviewView {
  url: string;
  status: 'PENDING' | 'READY' | 'FAILED';
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Resolved against the CDN base by the client, exactly like an attachment key. */
  imageKey: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
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
  /**
   * Whether the *requesting* user starred this message — never whether the peer
   * did. Starring is private, and leaking it here would leak it everywhere.
   */
  isStarred: boolean;
  linkPreview: LinkPreviewView | null;
}

/** A starred message, with the conversation it lives in. */
export interface StarredMessageView {
  message: MessageView;
  conversationId: string;
  /** The other participant, so the Starred screen can say which chat this came from. */
  peer: SocialUserCard;
  starredAt: Date;
}

/** The message pinned to the top of a thread. Shared by both participants. */
export interface PinnedMessageView {
  message: MessageView;
  pinnedBy: string;
  pinnedAt: Date;
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
  /** Preset id or storage key. Per-user: the peer sees their own. */
  wallpaper: string | null;
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
  /**
   * The thread's pinned banner, or null.
   *
   * Null for a user whose `clearedAt` cut-off is newer than the pinned message:
   * they deleted that history for themselves, and it must not reappear in a banner.
   */
  pinned: PinnedMessageView | null;
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
  wallpaper?: string | null;
}

/** The tabs on the conversation-media screen. */
export type MediaTab = 'IMAGES' | 'VIDEOS' | 'VOICE' | 'FILES' | 'LINKS';

export interface ListMediaInput {
  page: number;
  limit: number;
  tab: MediaTab;
}

export interface ListStarredInput {
  page: number;
  limit: number;
  /** Narrow to one conversation. Omit for every starred message the user has. */
  conversationId?: string;
  /** Keyset cursor: the id of the last starred row on the previous page. */
  cursor?: string;
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
  /** Delete for everyone. Sender-only; leaves an `isDeleted` tombstone both sides see. */
  deleteMessage(userId: string, messageId: string): Promise<void>;
  /**
   * Delete for me. Any participant may hide any message — that is what separates
   * this from `deleteMessage`, which is the sender's alone. No tombstone: the
   * message simply ceases to exist for this user, and the peer's copy is untouched.
   */
  hideMessage(userId: string, messageId: string): Promise<void>;
  editMessage(userId: string, messageId: string, content: string): Promise<MessageView>;
  react(userId: string, messageId: string, emoji: string): Promise<void>;
  unreact(userId: string, messageId: string, emoji: string): Promise<void>;

  // ---- Starring (private to the user) ----
  star(userId: string, messageId: string): Promise<void>;
  unstar(userId: string, messageId: string): Promise<void>;
  listStarred(userId: string, input: ListStarredInput): Promise<Paginated<StarredMessageView>>;

  /**
   * The media in one conversation, by tab.
   *
   * Returns whole messages rather than bare attachments: the gallery needs to know
   * who sent each item and when, and tapping one has to be able to jump back to it
   * in the thread.
   */
  listMedia(
    userId: string,
    conversationId: string,
    input: ListMediaInput,
  ): Promise<Paginated<MessageView>>;

  // ---- Pinned thread banner (shared by both participants) ----
  pinMessage(userId: string, conversationId: string, messageId: string): Promise<ConversationView>;
  unpinMessage(userId: string, conversationId: string): Promise<ConversationView>;
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
