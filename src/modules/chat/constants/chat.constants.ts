import { SOCKET_NAMESPACES } from 'src/common/constants/socket.constants';

/**
 * Chat module constants: the socket namespace, `chat.*` / `conversation.*`
 * event names, Redis key builders and fixed conventions. Tunable numbers
 * (message length, rate limits, typing TTL) live in the `chat` config
 * namespace, not here.
 */

/** Socket.IO namespace the ChatGateway serves (see infra/socket). */
export const CHAT_NAMESPACE = SOCKET_NAMESPACES.CHAT;

/**
 * Client-facing realtime event names. Every one is delivered to the per-user
 * room (`user:<id>`) of each participant on the `/chat` namespace — not to a
 * conversation room. Two consequences, both deliberate: a client needs no
 * `room:join` handshake before it can receive messages, and multi-device sync
 * is free, because all of a user's sockets sit in the same per-user room.
 */
export const CHAT_SOCKET_EVENTS = {
  // ---- Conversations ----
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_ACCEPTED: 'conversation.accepted',
  CONVERSATION_DECLINED: 'conversation.declined',
  CONVERSATION_CLEARED: 'conversation.cleared',
  /** Per-user settings (pin/archive/mute) changed — echoes to the owner's devices. */
  CONVERSATION_SETTINGS: 'conversation.settings',
  /** Composer draft changed — syncs the owner's other devices. */
  CONVERSATION_DRAFT: 'conversation.draft',

  // ---- Messages ----
  MESSAGE_NEW: 'message.new',
  MESSAGE_DELETED: 'message.deleted',
  MESSAGE_EDITED: 'message.edited',
  MESSAGE_REACTION: 'message.reaction',

  // ---- Receipts & indicators ----
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  TYPING: 'chat.typing',

  // ---- Badge ----
  UNREAD_TOTAL: 'chat.unread_total',
} as const;

/** What a typing indicator represents — a text composer or a voice recording. */
export const TYPING_KINDS = {
  TEXT: 'TEXT',
  VOICE: 'VOICE',
} as const;

export type TypingKind = (typeof TYPING_KINDS)[keyof typeof TYPING_KINDS];

/**
 * Canonical key for a DIRECT conversation: the two participant ids sorted and
 * joined, so `pairKey(a, b) === pairKey(b, a)` and the unique index makes
 * "open a chat with X" idempotent no matter who initiates.
 */
export function directPairKey(userA: string, userB: string): string {
  return [userA, userB].sort().join(':');
}

/** Rolling send-rate counter for a sender (per rate window). */
export function chatRateKey(userId: string): string {
  return `chat:rate:{${userId}}`;
}

/** Cached unread-badge total for a user. */
export function chatUnreadKey(userId: string): string {
  return `chat:unread:{${userId}}`;
}

/** Longest preview stored on the conversation row for the list. */
export const CONVERSATION_PREVIEW_MAX_LENGTH = 120;

/** Attachment-bearing message types (content may be empty for these). */
export const MEDIA_MESSAGE_TYPES = ['IMAGE', 'VOICE', 'VIDEO', 'FILE'] as const;
