import { Inject, Injectable } from '@nestjs/common';
import type { ConversationParticipant } from '@prisma/client';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import type { SocialUserCard } from 'src/modules/social/interfaces/social.interface';
import type { ConversationWithParticipants } from '../repositories/conversation.repository';
import type { MessageWithRelations } from '../repositories/message.repository';
import type {
  AttachmentView,
  ConversationView,
  LinkPreviewView,
  MessageView,
  PinnedMessageView,
  ReactionView,
} from '../interfaces/chat.service.interface';

/**
 * Assembles the API views. Kept apart from ChatService so the service reads as
 * business rules and this reads as shape-mapping — and so peer cards are
 * resolved in one batched PROFILE_SERVICE call per page instead of one per row
 * (the N+1 that would otherwise creep into the conversation list).
 */
@Injectable()
export class ChatViewMapper {
  constructor(
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    private readonly mediaUrls: MediaUrlResolver,
  ) {}

  /** Batch-resolve peer cards for a page of conversations. */
  async conversations(
    conversations: ConversationWithParticipants[],
    viewerId: string,
  ): Promise<ConversationView[]> {
    const peerIds = conversations
      .map((c) => this.peerOf(c, viewerId)?.userId)
      .filter((id): id is string => Boolean(id));

    const cards = await this.cards(peerIds);

    const out: ConversationView[] = [];
    for (const conversation of conversations) {
      const view = this.buildConversation(conversation, viewerId, cards);
      // A conversation whose peer no longer resolves (deleted account) is dropped
      // rather than rendered as a ghost row with no name or avatar.
      if (view) out.push(view);
    }
    return out;
  }

  async conversation(
    conversation: ConversationWithParticipants,
    viewerId: string,
    pinned: PinnedMessageView | null = null,
  ): Promise<ConversationView | null> {
    const peer = this.peerOf(conversation, viewerId);
    if (!peer) return null;
    const cards = await this.cards([peer.userId]);
    return this.buildConversation(conversation, viewerId, cards, null, pinned);
  }

  /** Build a conversation view from already-resolved cards (no I/O). */
  buildConversation(
    conversation: ConversationWithParticipants,
    viewerId: string,
    cards: Map<string, SocialUserCard>,
    lastMessage: MessageView | null = null,
    pinned: PinnedMessageView | null = null,
  ): ConversationView | null {
    const self = conversation.participants.find((p) => p.userId === viewerId);
    const peer = this.peerOf(conversation, viewerId);
    if (!self || !peer) return null;

    const card = cards.get(peer.userId);
    if (!card) return null;

    const isUnaccepted = conversation.acceptedAt === null;

    return {
      id: conversation.id,
      peer: card,
      lastMessage: lastMessage ?? this.previewMessage(conversation),
      self: {
        // A conversation the user marked unread shows a badge even though the read
        // watermark moved — the flag is what the UI counts, not the receipt.
        unreadCount: Math.max(self.unreadCount, self.manualUnread ? 1 : 0),
        isPinned: self.isPinned,
        isArchived: self.isArchived,
        isFavorite: self.isFavorite,
        isMuted: this.isMuted(self),
        mutedUntil: self.mutedUntil,
        draft: self.draft,
        lastReadMessageId: self.lastReadMessageId,
        manualUnread: self.manualUnread,
        wallpaper: self.wallpaper,
      },
      peerState: {
        lastReadMessageAt: peer.lastReadMessageAt,
        lastDeliveredMessageAt: peer.lastDeliveredMessageAt,
      },
      // Inbound request: someone else asked and it is still unaccepted.
      isRequest: isUnaccepted && conversation.requestedBy !== viewerId,
      // Outbound request: this user asked and the peer has not accepted yet.
      isPendingOutbound: isUnaccepted && conversation.requestedBy === viewerId,
      // A pin the *viewer* cleared away is not shown back to them. The pin is
      // shared, but this user's history is not, and resurrecting a message they
      // deleted for themselves inside a banner would undo the delete.
      pinned: this.visiblePin(pinned, self),
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  /** Suppress a pin that predates this user's "clear history" cut-off. */
  private visiblePin(
    pinned: PinnedMessageView | null,
    self: ConversationParticipant,
  ): PinnedMessageView | null {
    if (!pinned) return null;
    if (self.clearedAt && pinned.message.createdAt <= self.clearedAt) return null;
    return pinned;
  }

  /**
   * Map a page of messages, resolving the viewer's stars in **one** query.
   *
   * `isStarred` is per-viewer, so it cannot be baked into the row — and resolving
   * it per message would be an N+1 on the hottest read in the module.
   */
  async messagesFor(
    messages: MessageWithRelations[],
    viewerId: string,
    starredIds: Set<string>,
  ): Promise<MessageView[]> {
    const urls = await this.attachmentUrls(messages);
    return messages.map((m) => this.message(m, viewerId, starredIds.has(m.id), urls));
  }

  /** One message, with its media URLs resolved. For the single-message paths. */
  async messageWithMedia(
    message: MessageWithRelations,
    viewerId: string,
    isStarred = false,
  ): Promise<MessageView> {
    const urls = await this.attachmentUrls([message]);
    return this.message(message, viewerId, isStarred, urls);
  }

  /**
   * Resolve every attachment key on a page to a servable URL, in one pass.
   *
   * Deduped across the page, because the same key can appear twice (a message and
   * the thumbnail of another), and because without a CDN base each resolution is a
   * presigned-GET signature — cheap, but not free, and not worth doing twice.
   */
  private async attachmentUrls(messages: MessageWithRelations[]): Promise<Map<string, string>> {
    const keys = new Set<string>();
    for (const message of messages) {
      for (const attachment of message.attachments) {
        keys.add(attachment.storageKey);
        if (attachment.thumbnailKey) keys.add(attachment.thumbnailKey);
      }
    }
    if (keys.size === 0) return new Map();

    const resolved = await Promise.all(
      [...keys].map(async (key) => [key, await this.mediaUrls.resolve(key)] as const),
    );

    return new Map(
      resolved
        .filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
        .map(([key, url]) => [key, url]),
    );
  }

  message(
    message: MessageWithRelations,
    viewerId: string,
    isStarred = false,
    urls: Map<string, string> = new Map(),
  ): MessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      type: message.type,
      content: message.content,
      clientId: message.clientId,
      replyToId: message.replyToId,
      attachments: message.attachments.map((a): AttachmentView => ({
        id: a.id,
        type: a.type,
        storageKey: a.storageKey,
        thumbnailKey: a.thumbnailKey,
        url: urls.get(a.storageKey) ?? null,
        thumbnailUrl: a.thumbnailKey ? (urls.get(a.thumbnailKey) ?? null) : null,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        durationMs: a.durationMs,
        width: a.width,
        height: a.height,
        waveform: a.waveform,
        filename: a.filename,
      })),
      reactions: this.collapseReactions(message, viewerId),
      metadata: (message.metadata as Record<string, unknown> | null) ?? null,
      isDeleted: message.isDeleted,
      editedAt: message.editedAt,
      createdAt: message.createdAt,
      isStarred,
      linkPreview: this.linkPreview(message),
    };
  }

  messages(messages: MessageWithRelations[], viewerId: string): MessageView[] {
    return messages.map((m) => this.message(m, viewerId));
  }

  /**
   * The link card, or null when the message carries no link.
   *
   * A PENDING or FAILED preview is reported as such rather than flattened to null:
   * "still resolving" and "this link has no preview" are different facts, and a
   * client that cannot tell them apart either flickers or lies.
   */
  private linkPreview(message: MessageWithRelations): LinkPreviewView | null {
    const preview = message.linkPreview;
    if (!preview) return null;

    return {
      url: preview.url,
      status: preview.status,
      title: preview.title,
      description: preview.description,
      siteName: preview.siteName,
      imageKey: preview.imageKey,
      imageWidth: preview.imageWidth,
      imageHeight: preview.imageHeight,
    };
  }

  /** Resolve ids into cards, keyed for O(1) lookup. Unresolvable ids are absent. */
  async cards(ids: string[]): Promise<Map<string, SocialUserCard>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();

    const resolved = await this.profiles.getCards(unique);
    return new Map(
      resolved.map((c) => [
        c.id,
        {
          userId: c.id,
          username: c.username,
          fullName: c.fullName,
          avatarUrl: c.avatarUrl,
          verified: c.verified,
          level: c.level,
          vipLevel: c.vipLevel,
        },
      ]),
    );
  }

  peerOf(
    conversation: ConversationWithParticipants,
    viewerId: string,
  ): ConversationParticipant | undefined {
    return conversation.participants.find((p) => p.userId !== viewerId);
  }

  /** A timed mute that has elapsed is not a mute. */
  private isMuted(participant: ConversationParticipant): boolean {
    if (!participant.isMuted) return false;
    if (!participant.mutedUntil) return true;
    return participant.mutedUntil.getTime() > Date.now();
  }

  /**
   * Reactions collapsed to one entry per emoji with a count — the shape the UI
   * renders. Sending every reactor down would blow up a busy message's payload
   * for no benefit.
   */
  private collapseReactions(message: MessageWithRelations, viewerId: string): ReactionView[] {
    const byEmoji = new Map<string, { count: number; reactedByMe: boolean }>();
    for (const r of message.reactions) {
      const entry = byEmoji.get(r.emoji) ?? { count: 0, reactedByMe: false };
      entry.count += 1;
      if (r.userId === viewerId) entry.reactedByMe = true;
      byEmoji.set(r.emoji, entry);
    }
    return [...byEmoji.entries()]
      .map(([emoji, e]) => ({ emoji, count: e.count, reactedByMe: e.reactedByMe }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * The list preview, rebuilt from the denormalised `lastMessage*` columns —
   * no per-conversation message read. Attachments and reactions are not part of
   * a preview, so they are empty by construction.
   */
  private previewMessage(conversation: ConversationWithParticipants): MessageView | null {
    if (!conversation.lastMessageId || !conversation.lastMessageAt) return null;
    return {
      id: conversation.lastMessageId,
      conversationId: conversation.id,
      senderId: conversation.lastMessageSender ?? '',
      type: conversation.lastMessageType ?? 'TEXT',
      content: conversation.lastMessagePreview ?? '',
      clientId: '',
      replyToId: null,
      attachments: [],
      reactions: [],
      metadata: null,
      isDeleted: false,
      editedAt: null,
      createdAt: conversation.lastMessageAt,
      // A list preview is a denormalised snapshot, not the message. It carries no
      // star (which is per-viewer and not on the row) and no link card (which the
      // list does not render). Both would need a read the list exists to avoid.
      isStarred: false,
      linkPreview: null,
    };
  }
}
