import { Inject, Injectable } from '@nestjs/common';
import type { ConversationParticipant } from '@prisma/client';
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
  MessageView,
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
  constructor(@Inject(PROFILE_SERVICE) private readonly profiles: IProfileService) {}

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
  ): Promise<ConversationView | null> {
    const peer = this.peerOf(conversation, viewerId);
    if (!peer) return null;
    const cards = await this.cards([peer.userId]);
    return this.buildConversation(conversation, viewerId, cards);
  }

  /** Build a conversation view from already-resolved cards (no I/O). */
  buildConversation(
    conversation: ConversationWithParticipants,
    viewerId: string,
    cards: Map<string, SocialUserCard>,
    lastMessage: MessageView | null = null,
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
      },
      peerState: {
        lastReadMessageAt: peer.lastReadMessageAt,
        lastDeliveredMessageAt: peer.lastDeliveredMessageAt,
      },
      // Inbound request: someone else asked and it is still unaccepted.
      isRequest: isUnaccepted && conversation.requestedBy !== viewerId,
      // Outbound request: this user asked and the peer has not accepted yet.
      isPendingOutbound: isUnaccepted && conversation.requestedBy === viewerId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  message(message: MessageWithRelations, viewerId: string): MessageView {
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
    };
  }

  messages(messages: MessageWithRelations[], viewerId: string): MessageView[] {
    return messages.map((m) => this.message(m, viewerId));
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
    };
  }
}
