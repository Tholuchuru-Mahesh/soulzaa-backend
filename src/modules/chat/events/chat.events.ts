import { DomainEvent } from 'src/common/events';
import type { TypingKind } from '../constants/chat.constants';
import type {
  ConversationView,
  LinkPreviewView,
  MessageView,
} from '../interfaces/chat.service.interface';

/**
 * Chat events on the EVENT_BUS. The chat socket listener bridges them to the
 * `/chat` namespace (delivered into each recipient's `user:<id>` room); the
 * notification listener turns new messages and chat requests into push. Other
 * domains (analytics, the social interaction scorer) subscribe to the same
 * events without importing this module.
 *
 * Every payload carries `recipientIds` — the users who should receive it. The
 * listener never has to re-derive an audience, and "who sees what" stays a
 * single decision made in the service.
 */
export const CHAT_EVENTS = {
  CONVERSATION_CREATED: 'chat.conversation_created',
  CONVERSATION_ACCEPTED: 'chat.conversation_accepted',
  CONVERSATION_DECLINED: 'chat.conversation_declined',
  CONVERSATION_CLEARED: 'chat.conversation_cleared',
  CONVERSATION_SETTINGS: 'chat.conversation_settings',
  CONVERSATION_DRAFT: 'chat.conversation_draft',
  CONVERSATION_PINNED_MESSAGE: 'chat.conversation_pinned_message',
  MESSAGE_SENT: 'chat.message_sent',
  MESSAGE_DELETED: 'chat.message_deleted',
  MESSAGE_EDITED: 'chat.message_edited',
  MESSAGE_REACTION: 'chat.message_reaction',
  MESSAGE_STARRED: 'chat.message_starred',
  MESSAGE_HIDDEN: 'chat.message_hidden',
  MESSAGE_PREVIEW: 'chat.message_preview',
  MESSAGE_DELIVERED: 'chat.message_delivered',
  MESSAGE_READ: 'chat.message_read',
  TYPING: 'chat.typing',
} as const;

/** Base shape: every chat event names its recipients explicitly. */
interface Addressed {
  recipientIds: string[];
}

export class ConversationCreatedEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    /** Per-recipient view — the same conversation looks different to each side. */
    views: Record<string, ConversationView>;
    isRequest: boolean;
    requestedBy: string | null;
  }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_CREATED;
}

export class ConversationAcceptedEvent extends DomainEvent<
  Addressed & { conversationId: string; acceptedBy: string }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_ACCEPTED;
}

export class ConversationDeclinedEvent extends DomainEvent<
  Addressed & { conversationId: string; declinedBy: string }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_DECLINED;
}

export class ConversationClearedEvent extends DomainEvent<
  Addressed & { conversationId: string; clearedAt: string }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_CLEARED;
}

/**
 * Per-user settings changed (pin/archive/mute). Addressed only to the owner —
 * this is how their *other devices* stay in sync, not a peer-facing event.
 */
export class ConversationSettingsChangedEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    isPinned: boolean;
    isArchived: boolean;
    isFavorite: boolean;
    isMuted: boolean;
    mutedUntil: string | null;
  }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_SETTINGS;
}

/** Draft changed. Addressed only to the owner, for multi-device composer sync. */
export class ConversationDraftChangedEvent extends DomainEvent<
  Addressed & { conversationId: string; draft: string | null; draftAt: string | null }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_DRAFT;
}

export class MessageSentEvent extends DomainEvent<
  Addressed & {
    message: MessageView;
    senderId: string;
    /** Recipients who should get a push (peer, minus anyone who muted the chat). */
    notifyIds: string[];
    isRequest: boolean;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_SENT;
}

export class MessageDeletedEvent extends DomainEvent<
  Addressed & { conversationId: string; messageId: string; deletedBy: string }
> {
  readonly name = CHAT_EVENTS.MESSAGE_DELETED;
}

export class MessageEditedEvent extends DomainEvent<
  Addressed & { message: MessageView; editedBy: string }
> {
  readonly name = CHAT_EVENTS.MESSAGE_EDITED;
}

export class MessageReactionEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    messageId: string;
    userId: string;
    emoji: string;
    /** False when the reaction was removed. */
    added: boolean;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_REACTION;
}

export class MessageDeliveredEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    /** The user whose delivered-watermark advanced. */
    userId: string;
    messageId: string;
    deliveredAt: string;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_DELIVERED;
}

export class MessageReadEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    /** The user whose read-watermark advanced. */
    userId: string;
    messageId: string;
    readAt: string;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_READ;
}

/**
 * The thread's pinned banner changed. Addressed to **both** participants — unlike
 * a star, a pin is shared, and either side may set it.
 *
 * `message: null` means unpinned, including the implicit unpin that follows
 * deleting the pinned message for everyone.
 */
export class ConversationPinnedMessageEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    message: MessageView | null;
    pinnedBy: string | null;
    pinnedAt: string | null;
  }
> {
  readonly name = CHAT_EVENTS.CONVERSATION_PINNED_MESSAGE;
}

/**
 * A message was starred or unstarred. Addressed to the **owner only**.
 *
 * Starring is private. Telling the peer that their message was starred would leak
 * an action the user took about them, not with them.
 */
export class MessageStarredEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    messageId: string;
    starred: boolean;
    starredAt: string | null;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_STARRED;
}

/**
 * A message was deleted *for this user only*. Addressed to the owner's devices —
 * the peer must never learn their message was hidden, which is the whole
 * distinction between this and delete-for-everyone.
 */
export class MessageHiddenEvent extends DomainEvent<
  Addressed & { conversationId: string; messageId: string }
> {
  readonly name = CHAT_EVENTS.MESSAGE_HIDDEN;
}

/**
 * A link preview finished resolving. Addressed to both participants, who patch the
 * bubble in place. `preview` is null when the scrape failed.
 */
export class MessagePreviewEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    messageId: string;
    preview: LinkPreviewView | null;
  }
> {
  readonly name = CHAT_EVENTS.MESSAGE_PREVIEW;
}

/** Ephemeral — never persisted, never pushed. */
export class ChatTypingEvent extends DomainEvent<
  Addressed & {
    conversationId: string;
    userId: string;
    isTyping: boolean;
    kind: TypingKind;
  }
> {
  readonly name = CHAT_EVENTS.TYPING;
}
