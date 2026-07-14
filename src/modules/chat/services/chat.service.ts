import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AttachmentType, DirectMessageType, Prisma, ReportReason } from '@prisma/client';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { EVENT_BUS, type IEventBus } from 'src/common/events';
import type { Paginated } from 'src/common/interfaces/api-response.interface';
import { buildPaginated, normalizePagination } from 'src/common/utils/pagination.util';
import { CacheService } from 'src/infra/redis/cache.service';
import {
  PRIVACY_SERVICE,
  PrivacyAction,
  type IPrivacyService,
} from 'src/modules/privacy/interfaces/privacy.interface';
import {
  RELATIONSHIP_SERVICE,
  type IRelationshipProvider,
} from 'src/modules/privacy/interfaces/relationship-provider.interface';
import {
  SOCIAL_SERVICE,
  type ISocialService,
} from 'src/modules/social/interfaces/social.interface';
import {
  PROFILE_SERVICE,
  type IProfileService,
} from 'src/modules/users/interfaces/profile.interface';
import { MEDIA_MESSAGE_TYPES, chatUnreadKey, type TypingKind } from '../constants/chat.constants';
import {
  ChatTypingEvent,
  ConversationAcceptedEvent,
  ConversationClearedEvent,
  ConversationCreatedEvent,
  ConversationDeclinedEvent,
  ConversationDraftChangedEvent,
  ConversationPinnedMessageEvent,
  ConversationSettingsChangedEvent,
  MessageDeletedEvent,
  MessageDeliveredEvent,
  MessageEditedEvent,
  MessageHiddenEvent,
  MessageReactionEvent,
  MessageReadEvent,
  MessageSentEvent,
  MessageStarredEvent,
} from '../events/chat.events';
import type {
  CategoryCountsView,
  ConversationSettingsInput,
  ConversationView,
  IChatService,
  ListConversationsInput,
  ListMediaInput,
  ListStarredInput,
  MediaTab,
  MessageView,
  PinnedMessageView,
  SendMessageInput,
  StarredMessageView,
  UnreadTotalView,
} from '../interfaces/chat.service.interface';
import {
  ConversationRepository,
  type ConversationWithParticipants,
} from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ChatViewMapper } from './chat-view.mapper';

/** Resolved chat tuning, read once from the `chat` config namespace. */
interface ChatConfig {
  messageMaxLength: number;
  maxAttachments: number;
  rateMax: number;
  rateWindowSeconds: number;
  typingTtlSeconds: number;
  unreadCacheTtlSeconds: number;
  editWindowSeconds: number;
  maxPinned: number;
  maxStarred: number;
}

/** Which attachment kinds each media tab shows. LINKS is answered separately. */
const MEDIA_TAB_TYPES: Record<Exclude<MediaTab, 'LINKS'>, AttachmentType[]> = {
  IMAGES: [AttachmentType.IMAGE],
  VIDEOS: [AttachmentType.VIDEO],
  VOICE: [AttachmentType.VOICE],
  FILES: [AttachmentType.FILE],
};

/** Attachment kinds each media message type accepts. */
const TYPE_ATTACHMENT: Partial<Record<DirectMessageType, AttachmentType>> = {
  [DirectMessageType.IMAGE]: AttachmentType.IMAGE,
  [DirectMessageType.VOICE]: AttachmentType.VOICE,
  [DirectMessageType.VIDEO]: AttachmentType.VIDEO,
  [DirectMessageType.FILE]: AttachmentType.FILE,
};

/**
 * The key each rich type must carry in `metadata`. Chat stores a *reference* to
 * another domain's entity, never a copy of it — so a gift message names a giftId
 * and nothing else, and the client resolves it through the gifts module.
 */
const TYPE_METADATA_KEY: Partial<Record<DirectMessageType, string>> = {
  [DirectMessageType.GIFT]: 'giftId',
  [DirectMessageType.PROFILE_SHARE]: 'userId',
  [DirectMessageType.ROOM_INVITE]: 'roomId',
  [DirectMessageType.CALL_LOG]: 'callType',
};

/**
 * Direct messaging: conversations, messages, receipts, reactions, drafts and
 * chat requests, over the existing `/chat` namespace.
 *
 * Three rules shape everything here:
 *
 *  - **Persist, then publish.** A message row exists before any socket sees it,
 *    so a delivered event can never outrun the data it describes.
 *  - **REST mutates, sockets only notify.** Matching the platform convention
 *    (no gateway anywhere accepts a client command), every write lands through
 *    a guarded, validated, rate-limited HTTP route; the socket is a pure
 *    fan-out channel. Clients must never treat an emit as a write.
 *  - **Watermarks, not per-message receipts.** Read/delivery state is a
 *    high-water mark per participant, which keeps receipts O(1) per
 *    conversation instead of O(messages x participants).
 *
 * Who may message whom is delegated to PRIVACY_SERVICE (`PrivacyAction.MESSAGE`)
 * — the seam that was defined but had no caller until now. A first message from
 * a non-friend opens the conversation as a *request* rather than bypassing the
 * recipient's intent.
 */
@Injectable()
export class ChatService implements IChatService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository,
    private readonly views: ChatViewMapper,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    @Inject(EVENT_BUS) private readonly bus: IEventBus,
    @Inject(PRIVACY_SERVICE) private readonly privacy: IPrivacyService,
    @Inject(RELATIONSHIP_SERVICE) private readonly relationships: IRelationshipProvider,
    @Inject(PROFILE_SERVICE) private readonly profiles: IProfileService,
    @Inject(SOCIAL_SERVICE) private readonly social: ISocialService,
  ) {}

  private chatConfig(): ChatConfig {
    return this.config.get<ChatConfig>('chat', { infer: true })!;
  }

  // ============================ Conversations ============================

  async openDirect(userId: string, peerUserId: string): Promise<ConversationView> {
    if (userId === peerUserId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_MESSAGE_SELF,
        'You cannot message yourself',
        HttpStatus.BAD_REQUEST,
      );
    }

    const existing = await this.conversations.findByPair(userId, peerUserId);
    if (existing) return this.requireView(existing, userId);

    await this.assertMayMessage(userId, peerUserId);

    // Friends chat directly; anyone else has to ask first.
    const asRequest = !(await this.relationships.isFriend(userId, peerUserId));
    const conversation = await this.conversations.openDirect(userId, peerUserId, { asRequest });

    const view = await this.requireView(conversation, userId);
    const peerView = await this.views.conversation(conversation, peerUserId);

    await this.bus.publish(
      new ConversationCreatedEvent({
        recipientIds: [userId, peerUserId],
        conversationId: conversation.id,
        views: {
          [userId]: view,
          ...(peerView ? { [peerUserId]: peerView } : {}),
        },
        isRequest: asRequest,
        requestedBy: asRequest ? userId : null,
      }),
    );

    return view;
  }

  async getConversation(userId: string, conversationId: string): Promise<ConversationView> {
    const conversation = await this.requireParticipant(conversationId, userId);
    return this.requireView(conversation, userId);
  }

  async listConversations(
    userId: string,
    input: ListConversationsInput,
  ): Promise<Paginated<ConversationView>> {
    const { page, limit, skip } = normalizePagination(input);

    // A search term resolves to peer ids first (PROFILE_SERVICE already excludes
    // blocked users), so the conversation query stays a plain indexed filter and
    // this module never reaches into the users tables.
    let peerIdFilter: string[] | undefined;
    if (input.search?.trim()) {
      const matches = await this.profiles.search(
        input.search.trim(),
        { page: 1, limit: 50 },
        userId,
      );
      peerIdFilter = matches.items.map((u) => u.id);
      if (peerIdFilter.length === 0) return buildPaginated([], 0, page, limit);
    }

    // FRIENDS and BLOCKED are graph questions, not chat questions — they are
    // answered by the social/privacy contracts and passed down as id sets, so this
    // module still never reads another domain's tables.
    const [friendIds, blockedIds] = await Promise.all([
      input.filter === 'FRIENDS' ? this.social.friendIds(userId) : Promise.resolve([]),
      input.filter === 'BLOCKED' ? this.privacy.listBlocked(userId) : Promise.resolve([]),
    ]);

    const [rows, total] = await this.conversations.list(userId, {
      filter: input.filter,
      skip,
      take: limit,
      peerIdFilter,
      friendIds,
      blockedIds: blockedIds.map((b) => b.userId),
      cursor: input.cursor,
    });

    const views = await this.views.conversations(rows, userId);
    await this.repairHiddenPreviews(views, userId);
    const ordered = input.filter === 'INBOX' ? this.pinnedFirst(views) : views;
    return buildPaginated(ordered, total, page, limit);
  }

  /**
   * Replace the list preview of any conversation whose last message this user
   * hid for themselves.
   *
   * `Conversation.lastMessage*` is denormalised and **shared** — so without this,
   * a user who deletes the newest message for themselves still sees it as their
   * Chats-list preview, which quietly undoes the delete on the one screen they are
   * most likely to be looking at.
   *
   * Deliberately not a per-user preview column. The lookup below is one batched
   * read for the page, and the repair itself only runs for the rare row that
   * actually needs it — so the common case pays nothing.
   */
  private async repairHiddenPreviews(views: ConversationView[], userId: string): Promise<void> {
    const lastIds = views.map((v) => v.lastMessage?.id).filter((id): id is string => Boolean(id));
    if (lastIds.length === 0) return;

    const hidden = await this.messages.hiddenIdsAmong(lastIds, userId);
    if (hidden.size === 0) return;

    await Promise.all(
      views.map(async (view) => {
        const lastId = view.lastMessage?.id;
        if (!lastId || !hidden.has(lastId)) return;

        const replacement = await this.messages.newestVisible(view.id, userId);
        // No visible message left at all — the row shows no preview rather than
        // one the user has deleted.
        view.lastMessage = replacement
          ? await this.views.messageWithMedia(replacement, userId)
          : null;
      }),
    );
  }

  async categoryCounts(userId: string): Promise<CategoryCountsView> {
    const [friendIds, blocked] = await Promise.all([
      this.social.friendIds(userId),
      this.privacy.listBlocked(userId),
    ]);
    return this.conversations.categoryCounts(userId, {
      friendIds,
      blockedIds: blocked.map((b) => b.userId),
    });
  }

  async updateSettings(
    userId: string,
    conversationId: string,
    input: ConversationSettingsInput,
  ): Promise<ConversationView> {
    await this.requireParticipant(conversationId, userId);

    // Pinning is capped so the pinned section stays a shortlist rather than a
    // second copy of the inbox. Only a *new* pin is checked — re-pinning something
    // already pinned, or unpinning, must never be blocked by the limit.
    if (input.isPinned === true) {
      const existing = await this.conversations.participant(conversationId, userId);
      if (existing && !existing.isPinned) {
        const pinned = await this.conversations.countPinned(userId);
        const max = this.chatConfig().maxPinned;
        if (pinned >= max) {
          throw new BusinessException(
            ERROR_CODES.PIN_LIMIT_REACHED,
            `You can pin at most ${max} conversations`,
            HttpStatus.CONFLICT,
          );
        }
      }
    }

    const participant = await this.conversations.updateParticipant(conversationId, userId, {
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      ...(input.isFavorite !== undefined ? { isFavorite: input.isFavorite } : {}),
      ...(input.isMuted !== undefined ? { isMuted: input.isMuted } : {}),
      ...(input.mutedUntil !== undefined ? { mutedUntil: input.mutedUntil } : {}),
      ...(input.wallpaper !== undefined ? { wallpaper: input.wallpaper } : {}),
    });

    await this.invalidateUnread(userId);

    // Addressed to the owner only — this is multi-device sync, not a peer signal.
    await this.bus.publish(
      new ConversationSettingsChangedEvent({
        recipientIds: [userId],
        conversationId,
        isPinned: participant.isPinned,
        isArchived: participant.isArchived,
        isFavorite: participant.isFavorite,
        isMuted: participant.isMuted,
        mutedUntil: participant.mutedUntil?.toISOString() ?? null,
      }),
    );

    const fresh = await this.requireParticipant(conversationId, userId);
    return this.requireView(fresh, userId);
  }

  async saveDraft(userId: string, conversationId: string, text: string | null): Promise<void> {
    await this.requireParticipant(conversationId, userId);

    const draft = text?.trim() ? text : null;
    const draftAt = draft ? new Date() : null;
    await this.conversations.updateParticipant(conversationId, userId, { draft, draftAt });

    await this.bus.publish(
      new ConversationDraftChangedEvent({
        recipientIds: [userId],
        conversationId,
        draft,
        draftAt: draftAt?.toISOString() ?? null,
      }),
    );
  }

  /** "Delete for me" — hides history behind a cut-off without touching the peer's copy. */
  async clearHistory(userId: string, conversationId: string): Promise<void> {
    await this.requireParticipant(conversationId, userId);

    const clearedAt = new Date();
    await this.conversations.updateParticipant(conversationId, userId, {
      clearedAt,
      unreadCount: 0,
    });
    await this.invalidateUnread(userId);

    await this.bus.publish(
      new ConversationClearedEvent({
        recipientIds: [userId],
        conversationId,
        clearedAt: clearedAt.toISOString(),
      }),
    );
  }

  // ============================ Chat requests ============================

  async acceptRequest(userId: string, conversationId: string): Promise<ConversationView> {
    const conversation = await this.requireParticipant(conversationId, userId);
    this.assertInboundRequest(conversation, userId);

    await this.conversations.accept(conversationId);
    const fresh = await this.requireParticipant(conversationId, userId);
    const peerId = this.peerIdOf(fresh, userId);

    await this.bus.publish(
      new ConversationAcceptedEvent({
        recipientIds: [userId, peerId],
        conversationId,
        acceptedBy: userId,
      }),
    );

    return this.requireView(fresh, userId);
  }

  /**
   * Decline: archive it for the recipient and tell the requester. The row is
   * kept (not deleted) so the requester cannot re-open a fresh request to farm
   * the recipient's inbox — a decline has to actually stick.
   */
  async declineRequest(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.requireParticipant(conversationId, userId);
    this.assertInboundRequest(conversation, userId);

    await this.conversations.updateParticipant(conversationId, userId, {
      isArchived: true,
      unreadCount: 0,
    });
    await this.invalidateUnread(userId);

    const peerId = this.peerIdOf(conversation, userId);
    await this.bus.publish(
      new ConversationDeclinedEvent({
        recipientIds: [userId, peerId],
        conversationId,
        declinedBy: userId,
      }),
    );
  }

  // ============================== Messages ==============================

  async sendMessage(
    userId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<MessageView> {
    const cfg = this.chatConfig();
    const conversation = await this.requireParticipant(conversationId, userId);
    const peerId = this.peerIdOf(conversation, userId);

    // Re-checked on every send, not just at open: a block or a privacy change
    // after the conversation existed must take effect immediately.
    await this.assertMayMessage(userId, peerId);
    this.assertMaySendIntoRequest(conversation, userId);

    const content = (input.content ?? '').trim();
    this.assertSendable(input, content, cfg);
    await this.assertNotRateLimited(userId, cfg);

    const { message, created } = await this.messages.create({
      conversationId,
      senderId: userId,
      type: input.type,
      content,
      clientId: input.clientId,
      replyToId: input.replyToId ?? null,
      metadata: (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      attachments: (input.attachments ?? []).map((a) => ({
        type: a.type,
        storageKey: a.storageKey,
        thumbnailKey: a.thumbnailKey ?? null,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        durationMs: a.durationMs ?? null,
        width: a.width ?? null,
        height: a.height ?? null,
        waveform: a.waveform ?? [],
        filename: a.filename ?? null,
      })),
    });

    const view = await this.views.messageWithMedia(message, userId);

    // A retried send resolves to the existing row. Return it, but do not
    // re-run the side effects — otherwise one flaky network would double the
    // peer's unread count and fire a second push for a message they already have.
    if (!created) return view;

    await this.conversations.touchLastMessage(
      conversationId,
      message,
      this.preview(message.type, content),
    );
    await this.conversations.incrementUnreadForPeers(conversationId, userId);
    await this.invalidateUnread(peerId);

    const peerParticipant = this.views.peerOf(conversation, userId);
    const peerMuted = peerParticipant?.isMuted === true;

    await this.bus.publish(
      new MessageSentEvent({
        recipientIds: [userId, peerId],
        message: view,
        senderId: userId,
        // Muted chats still deliver in realtime; they just don't buzz the phone.
        notifyIds: peerMuted ? [] : [peerId],
        isRequest: conversation.acceptedAt === null,
      }),
    );

    return view;
  }

  async history(
    userId: string,
    conversationId: string,
    opts: { page: number; limit: number; before?: string },
  ): Promise<Paginated<MessageView>> {
    await this.requireParticipant(conversationId, userId);
    const { page, limit, skip } = normalizePagination(opts);

    const self = await this.conversations.participant(conversationId, userId);
    const [rows, total] = await this.messages.list(conversationId, {
      skip,
      take: limit,
      before: opts.before,
      clearedAt: self?.clearedAt ?? null,
      // Excludes the messages this user deleted for themselves. The peer's copy of
      // each is untouched — that is the whole point of "delete for me".
      viewerId: userId,
    });

    // One query for the whole page, never one per row.
    const starred = await this.messages.starredIdsAmong(
      rows.map((m) => m.id),
      userId,
    );

    return buildPaginated(await this.views.messagesFor(rows, userId, starred), total, page, limit);
  }

  async deleteMessage(userId: string, messageId: string): Promise<void> {
    const message = await this.messages.findById(messageId);
    if (!message) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (message.senderId !== userId) {
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        'You can only delete your own messages',
        HttpStatus.FORBIDDEN,
      );
    }

    const conversation = await this.requireParticipant(message.conversationId, userId);
    await this.messages.softDelete(messageId);

    const recipientIds = conversation.participants.map((p) => p.userId);

    await this.bus.publish(
      new MessageDeletedEvent({
        recipientIds,
        conversationId: message.conversationId,
        messageId,
        deletedBy: userId,
      }),
    );

    // A banner must not outlive the message it pins. Deleting a pinned message for
    // everyone implicitly unpins it — otherwise both participants keep staring at a
    // tombstone at the top of the thread.
    if (conversation.pinnedMessageId === messageId) {
      await this.conversations.setPinnedMessage(message.conversationId, null);
      await this.bus.publish(
        new ConversationPinnedMessageEvent({
          recipientIds,
          conversationId: message.conversationId,
          message: null,
          pinnedBy: null,
          pinnedAt: null,
        }),
      );
    }
  }

  /**
   * Delete for me. Hides one message from one user, leaving the peer's copy alone.
   *
   * Any participant may hide any message — their own or the peer's. That is what
   * separates this from {@link deleteMessage}, which is the sender's alone and
   * removes the message for both sides. No tombstone is left: the message simply
   * ceases to exist for this user.
   */
  async hideMessage(userId: string, messageId: string): Promise<void> {
    const { message } = await this.requireMessageAccess(userId, messageId);

    await this.messages.hide(messageId, userId, message.conversationId);

    // Addressed to the owner alone. The peer must never learn their message was
    // hidden — a "delete for me" the other side can observe is not one.
    await this.bus.publish(
      new MessageHiddenEvent({
        recipientIds: [userId],
        conversationId: message.conversationId,
        messageId,
      }),
    );
  }

  /**
   * The conversation's media, by tab.
   *
   * Same visibility rules as history — nothing deleted, nothing this user hid, and
   * nothing before their clear-history cut-off. A media tab that surfaces a photo
   * the user deleted for themselves would quietly undo the delete.
   */
  async listMedia(
    userId: string,
    conversationId: string,
    input: ListMediaInput,
  ): Promise<Paginated<MessageView>> {
    await this.requireParticipant(conversationId, userId);
    const { page, limit, skip } = normalizePagination(input);

    const self = await this.conversations.participant(conversationId, userId);
    const clearedAt = self?.clearedAt ?? null;

    const [rows, total] =
      input.tab === 'LINKS'
        ? await this.messages.listLinks(conversationId, {
            skip,
            take: limit,
            viewerId: userId,
            clearedAt,
          })
        : await this.messages.listMedia(conversationId, {
            skip,
            take: limit,
            viewerId: userId,
            clearedAt,
            types: MEDIA_TAB_TYPES[input.tab],
          });

    const starred = await this.messages.starredIdsAmong(
      rows.map((m) => m.id),
      userId,
    );

    return buildPaginated(await this.views.messagesFor(rows, userId, starred), total, page, limit);
  }

  // ============================== Starring ==============================

  async star(userId: string, messageId: string): Promise<void> {
    const { message } = await this.requireMessageAccess(userId, messageId);

    if (message.isDeleted) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found',
        HttpStatus.NOT_FOUND,
      );
    }

    // Starring something you already deleted for yourself would put it back in
    // front of you, in the Starred screen.
    if (await this.messages.isHidden(messageId, userId)) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found',
        HttpStatus.NOT_FOUND,
      );
    }

    // An uncapped per-user table is an availability incident waiting to happen.
    const count = await this.messages.countStars(userId);
    if (count >= this.chatConfig().maxStarred) {
      throw new BusinessException(
        ERROR_CODES.STAR_LIMIT_REACHED,
        `You can star at most ${this.chatConfig().maxStarred} messages`,
        HttpStatus.CONFLICT,
      );
    }

    const added = await this.messages.star(messageId, userId, message.conversationId);
    if (!added) return; // Already starred — idempotent, not a conflict.

    await this.publishStarred(userId, message.conversationId, messageId, true);
  }

  async unstar(userId: string, messageId: string): Promise<void> {
    const { message } = await this.requireMessageAccess(userId, messageId);

    const removed = await this.messages.unstar(messageId, userId);
    if (!removed) return;

    await this.publishStarred(userId, message.conversationId, messageId, false);
  }

  /** The owner's devices only — a star is private, and its echo must be too. */
  private publishStarred(
    userId: string,
    conversationId: string,
    messageId: string,
    starred: boolean,
  ): Promise<void> {
    return this.bus.publish(
      new MessageStarredEvent({
        recipientIds: [userId],
        conversationId,
        messageId,
        starred,
        starredAt: starred ? new Date().toISOString() : null,
      }),
    );
  }

  async listStarred(
    userId: string,
    input: ListStarredInput,
  ): Promise<Paginated<StarredMessageView>> {
    const { page, limit, skip } = normalizePagination(input);

    const [rows, total] = await this.messages.listStarred(userId, {
      skip,
      take: limit,
      conversationId: input.conversationId,
      cursor: input.cursor,
    });

    // The Starred screen has to say which chat each message came from, so the peer
    // cards are resolved in one batched call for the page — not one per row.
    const conversationIds = [...new Set(rows.map((r) => r.conversationId))];
    const conversations = await Promise.all(
      conversationIds.map((id) => this.conversations.findById(id)),
    );

    const peerByConversation = new Map<string, string>();
    for (const conversation of conversations) {
      if (!conversation) continue;
      const peer = this.views.peerOf(conversation, userId);
      if (peer) peerByConversation.set(conversation.id, peer.userId);
    }

    const cards = await this.views.cards([...peerByConversation.values()]);

    const views: StarredMessageView[] = [];
    for (const row of rows) {
      const peerId = peerByConversation.get(row.conversationId);
      const card = peerId ? cards.get(peerId) : undefined;
      // A conversation whose peer no longer resolves (deleted account) is dropped
      // rather than rendered as a starred message from nobody.
      if (!card) continue;

      views.push({
        message: await this.views.messageWithMedia(row.message, userId, true),
        conversationId: row.conversationId,
        peer: card,
        starredAt: row.createdAt,
      });
    }

    return buildPaginated(views, total, page, limit);
  }

  // ========================= Pinned thread banner =========================

  async pinMessage(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<ConversationView> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const message = await this.messages.findById(messageId);

    // The message must belong to *this* conversation, still exist, and not be one
    // the pinner deleted for themselves — pinning something you cannot see is
    // pinning it for the peer alone, which nobody asked for.
    if (
      !message ||
      message.conversationId !== conversationId ||
      message.isDeleted ||
      (await this.messages.isHidden(messageId, userId))
    ) {
      throw new BusinessException(
        ERROR_CODES.PIN_MESSAGE_INVALID,
        'That message cannot be pinned',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Single slot: pinning replaces whatever was pinned before.
    const updated = await this.conversations.setPinnedMessage(conversationId, {
      messageId,
      pinnedBy: userId,
    });

    const view = await this.views.messageWithMedia(message, userId);

    await this.bus.publish(
      new ConversationPinnedMessageEvent({
        // Shared, unlike a star: both participants see the banner.
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId,
        message: view,
        pinnedBy: userId,
        pinnedAt: (updated.pinnedAt ?? new Date()).toISOString(),
      }),
    );

    return this.getConversation(userId, conversationId);
  }

  async unpinMessage(userId: string, conversationId: string): Promise<ConversationView> {
    const conversation = await this.requireParticipant(conversationId, userId);

    await this.conversations.setPinnedMessage(conversationId, null);

    await this.bus.publish(
      new ConversationPinnedMessageEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId,
        message: null,
        pinnedBy: null,
        pinnedAt: null,
      }),
    );

    return this.getConversation(userId, conversationId);
  }

  async react(userId: string, messageId: string, emoji: string): Promise<void> {
    const { message, conversation } = await this.requireMessageAccess(userId, messageId);
    const added = await this.messages.addReaction(messageId, userId, emoji);
    if (!added) return; // Already reacted with this emoji — idempotent no-op.

    await this.bus.publish(
      new MessageReactionEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId: message.conversationId,
        messageId,
        userId,
        emoji,
        added: true,
      }),
    );
  }

  async unreact(userId: string, messageId: string, emoji: string): Promise<void> {
    const { message, conversation } = await this.requireMessageAccess(userId, messageId);
    const removed = await this.messages.removeReaction(messageId, userId, emoji);
    if (!removed) return;

    await this.bus.publish(
      new MessageReactionEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId: message.conversationId,
        messageId,
        userId,
        emoji,
        added: false,
      }),
    );
  }

  /**
   * Restore the badge without rewinding the read receipt.
   *
   * The peer's blue ticks stay blue, because they *were* earned: this user did read
   * the message. Marking unread is a private reminder, not a retraction — conflating
   * the two would let anyone silently un-read a message someone watched them read.
   */
  async markUnread(userId: string, conversationId: string): Promise<void> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const participant = await this.conversations.markUnread(conversationId, userId);
    await this.invalidateUnread(userId);

    await this.bus.publish(
      new ConversationSettingsChangedEvent({
        recipientIds: [userId],
        conversationId: conversation.id,
        isPinned: participant.isPinned,
        isArchived: participant.isArchived,
        isFavorite: participant.isFavorite,
        isMuted: participant.isMuted,
        mutedUntil: participant.mutedUntil?.toISOString() ?? null,
      }),
    );
  }

  async editMessage(userId: string, messageId: string, content: string): Promise<MessageView> {
    const cfg = this.chatConfig();
    const message = await this.messages.findById(messageId);
    if (!message) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found',
        HttpStatus.NOT_FOUND,
      );
    }

    const conversation = await this.requireParticipant(message.conversationId, userId);

    if (message.senderId !== userId || message.isDeleted) {
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        'You can only edit your own messages',
        HttpStatus.FORBIDDEN,
      );
    }

    // Past the window an edit stops being a correction and becomes a rewrite of
    // what the other person already read and replied to.
    const ageSeconds = (Date.now() - message.createdAt.getTime()) / 1000;
    if (ageSeconds > cfg.editWindowSeconds) {
      throw new BusinessException(
        ERROR_CODES.DM_EDIT_WINDOW_CLOSED,
        'This message can no longer be edited',
        HttpStatus.CONFLICT,
      );
    }

    const trimmed = content.trim();
    if (trimmed.length === 0 || trimmed.length > cfg.messageMaxLength) {
      throw new BusinessException(
        ERROR_CODES.DM_TOO_LONG,
        `Message must be 1-${cfg.messageMaxLength} characters`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.messages.edit(messageId, trimmed);
    const view = await this.views.messageWithMedia(updated, userId);

    // If it was the newest message, the list preview is now stale.
    if (conversation.lastMessageId === messageId) {
      await this.conversations.touchLastMessage(
        conversation.id,
        updated,
        this.preview(updated.type, trimmed),
      );
    }

    await this.bus.publish(
      new MessageEditedEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        message: view,
        editedBy: userId,
      }),
    );

    return view;
  }

  async report(
    userId: string,
    conversationId: string,
    input: { reason: ReportReason; messageId?: string; description?: string },
  ): Promise<{ reportId: string }> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const targetUserId = this.peerIdOf(conversation, userId);

    if (targetUserId === userId) {
      throw new BusinessException(
        ERROR_CODES.CANNOT_REPORT_SELF,
        'You cannot report yourself',
        HttpStatus.BAD_REQUEST,
      );
    }

    // A report naming a message must name one that is actually in this conversation,
    // or the moderator queue fills with dangling references.
    if (input.messageId) await this.requireMessageIn(conversationId, input.messageId);

    const report = await this.messages.createReport({
      conversationId,
      messageId: input.messageId ?? null,
      reporterId: userId,
      targetUserId,
      reason: input.reason,
      description: input.description ?? null,
    });

    return { reportId: report.id };
  }

  // ========================= Receipts & indicators =========================

  async markRead(userId: string, conversationId: string, messageId: string): Promise<void> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const message = await this.requireMessageIn(conversationId, messageId);

    const advanced = await this.conversations.advanceReadWatermark(
      conversationId,
      userId,
      messageId,
      message.createdAt,
    );

    // Opening the chat also clears an explicit "mark unread" — the user is looking
    // at it now, so the flag they set has served its purpose. This runs even when
    // the watermark did not move, because the flag is what the badge reads.
    const self = await this.conversations.participant(conversationId, userId);
    if (self?.manualUnread) {
      await this.conversations.updateParticipant(conversationId, userId, {
        manualUnread: false,
        unreadCount: 0,
      });
      await this.invalidateUnread(userId);
    }

    // Already read up to here (a slower device catching up) — nothing changed,
    // so don't re-broadcast and don't re-bust the badge cache.
    if (!advanced) return;

    await this.invalidateUnread(userId);

    await this.bus.publish(
      new MessageReadEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId,
        userId,
        messageId,
        readAt: new Date().toISOString(),
      }),
    );
  }

  async markDelivered(userId: string, conversationId: string, messageId: string): Promise<void> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const message = await this.requireMessageIn(conversationId, messageId);

    const advanced = await this.conversations.advanceDeliveredWatermark(
      conversationId,
      userId,
      messageId,
      message.createdAt,
    );
    if (!advanced) return;

    await this.bus.publish(
      new MessageDeliveredEvent({
        recipientIds: conversation.participants.map((p) => p.userId),
        conversationId,
        userId,
        messageId,
        deliveredAt: new Date().toISOString(),
      }),
    );
  }

  /** Ephemeral: broadcast only, never persisted, never pushed. */
  async typing(
    userId: string,
    conversationId: string,
    isTyping: boolean,
    kind: TypingKind,
  ): Promise<void> {
    const conversation = await this.requireParticipant(conversationId, userId);
    const peerId = this.peerIdOf(conversation, userId);

    await this.bus.publish(
      new ChatTypingEvent({
        // The typist's own devices don't need to see it — only the peer.
        recipientIds: [peerId],
        conversationId,
        userId,
        isTyping,
        kind,
      }),
    );
  }

  // =============================== Badge ===============================

  async unreadTotal(userId: string): Promise<UnreadTotalView> {
    const cached = await this.cache.get<UnreadTotalView>(chatUnreadKey(userId));
    if (cached) return cached;

    const [totals, requests] = await Promise.all([
      this.conversations.unreadTotals(userId),
      this.conversations.countInboundRequests(userId),
    ]);

    const view: UnreadTotalView = { ...totals, requests };
    await this.cache.set(chatUnreadKey(userId), view, this.chatConfig().unreadCacheTtlSeconds);
    return view;
  }

  // ============================== Guards ==============================

  /**
   * The recipient's `messagePermission` decides. This is the first caller of
   * `PrivacyAction.MESSAGE` — the check also short-circuits on a block in
   * either direction, which is what makes blocking actually stop messages.
   */
  private async assertMayMessage(senderId: string, recipientId: string): Promise<void> {
    const allowed = await this.privacy.check(senderId, recipientId, PrivacyAction.MESSAGE);
    if (!allowed) {
      throw new BusinessException(
        ERROR_CODES.MESSAGING_NOT_ALLOWED,
        'This user does not accept messages from you',
        HttpStatus.FORBIDDEN,
      );
    }
  }

  /**
   * While a request is pending, only the requester may keep writing — the
   * recipient has not opted in yet. Without this, "decline" would be cosmetic:
   * the requester could keep filling a conversation the recipient never accepted.
   */
  private assertMaySendIntoRequest(
    conversation: ConversationWithParticipants,
    senderId: string,
  ): void {
    if (conversation.acceptedAt !== null) return;
    if (conversation.requestedBy === senderId) return;

    throw new BusinessException(
      ERROR_CODES.CHAT_REQUEST_PENDING,
      'Accept this chat request before replying',
      HttpStatus.CONFLICT,
    );
  }

  private assertInboundRequest(conversation: ConversationWithParticipants, userId: string): void {
    const isInboundRequest =
      conversation.acceptedAt === null && conversation.requestedBy !== userId;
    if (!isInboundRequest) {
      throw new BusinessException(
        ERROR_CODES.CHAT_REQUEST_NOT_FOUND,
        'No pending chat request on this conversation',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private assertSendable(input: SendMessageInput, content: string, cfg: ChatConfig): void {
    const attachments = input.attachments ?? [];
    const isMedia = (MEDIA_MESSAGE_TYPES as readonly string[]).includes(input.type);

    // A rich type without its payload is unrenderable — a gift bubble with no gift.
    const requiredKey = TYPE_METADATA_KEY[input.type];
    if (requiredKey) {
      const value = input.metadata?.[requiredKey];
      if (value === undefined || value === null || value === '') {
        throw new BusinessException(
          ERROR_CODES.METADATA_INVALID,
          `A ${input.type} message requires metadata.${requiredKey}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      return;
    }

    if (content.length > cfg.messageMaxLength) {
      throw new BusinessException(
        ERROR_CODES.DM_TOO_LONG,
        `Message exceeds ${cfg.messageMaxLength} characters`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (attachments.length > cfg.maxAttachments) {
      throw new BusinessException(
        ERROR_CODES.TOO_MANY_ATTACHMENTS,
        `At most ${cfg.maxAttachments} attachments per message`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // A media message needs media; a text message needs text. Either way, a
    // message with nothing in it is never valid.
    if (isMedia) {
      const expected = TYPE_ATTACHMENT[input.type];
      if (attachments.length === 0) {
        throw new BusinessException(
          ERROR_CODES.ATTACHMENT_INVALID,
          `A ${input.type} message requires at least one attachment`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (expected && attachments.some((a) => a.type !== expected)) {
        throw new BusinessException(
          ERROR_CODES.ATTACHMENT_INVALID,
          `A ${input.type} message accepts only ${expected} attachments`,
          HttpStatus.BAD_REQUEST,
        );
      }
      return;
    }

    if (content.length === 0) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Message content is required',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertNotRateLimited(userId: string, cfg: ChatConfig): Promise<void> {
    const count = await this.messages.bumpSendRate(userId, cfg.rateWindowSeconds);
    if (count > cfg.rateMax) {
      throw new BusinessException(
        ERROR_CODES.DM_RATE_LIMITED,
        'You are sending messages too quickly',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async requireParticipant(
    conversationId: string,
    userId: string,
  ): Promise<ConversationWithParticipants> {
    const conversation = await this.conversations.findById(conversationId);
    if (!conversation) {
      throw new BusinessException(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        'Conversation not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const isParticipant = conversation.participants.some(
      (p) => p.userId === userId && p.leftAt === null,
    );
    if (!isParticipant) {
      throw new BusinessException(
        ERROR_CODES.NOT_A_PARTICIPANT,
        'You are not part of this conversation',
        HttpStatus.FORBIDDEN,
      );
    }
    return conversation;
  }

  private async requireMessageIn(conversationId: string, messageId: string) {
    const message = await this.messages.findById(messageId);
    if (!message || message.conversationId !== conversationId) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found in this conversation',
        HttpStatus.NOT_FOUND,
      );
    }
    return message;
  }

  private async requireMessageAccess(userId: string, messageId: string) {
    const message = await this.messages.findById(messageId);
    if (!message) {
      throw new BusinessException(
        ERROR_CODES.DM_NOT_FOUND,
        'Message not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const conversation = await this.requireParticipant(message.conversationId, userId);
    return { message, conversation };
  }

  // ============================== Helpers ==============================

  /**
   * The thread's pinned banner as *this* user should see it.
   *
   * Null when nothing is pinned, when the pinned message has since been deleted
   * for everyone, or when this user hid it for themselves — a "delete for me" that
   * a banner then resurrects is not a delete.
   */
  private async pinnedView(
    conversation: ConversationWithParticipants,
    userId: string,
  ): Promise<PinnedMessageView | null> {
    const { pinnedMessageId, pinnedBy, pinnedAt } = conversation;
    if (!pinnedMessageId || !pinnedBy || !pinnedAt) return null;

    const message = await this.messages.findById(pinnedMessageId);
    if (!message || message.isDeleted) return null;
    if (await this.messages.isHidden(pinnedMessageId, userId)) return null;

    return {
      message: await this.views.messageWithMedia(message, userId),
      pinnedBy,
      pinnedAt,
    };
  }

  private async requireView(
    conversation: ConversationWithParticipants,
    userId: string,
  ): Promise<ConversationView> {
    const pinned = await this.pinnedView(conversation, userId);
    const view = await this.views.conversation(conversation, userId, pinned);
    if (!view) {
      throw new BusinessException(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        'Conversation is no longer available',
        HttpStatus.NOT_FOUND,
      );
    }
    return view;
  }

  private peerIdOf(conversation: ConversationWithParticipants, userId: string): string {
    const peer = this.views.peerOf(conversation, userId);
    if (!peer) {
      throw new BusinessException(
        ERROR_CODES.CONVERSATION_NOT_FOUND,
        'Conversation has no peer',
        HttpStatus.NOT_FOUND,
      );
    }
    return peer.userId;
  }

  private pinnedFirst(views: ConversationView[]): ConversationView[] {
    return [...views].sort((a, b) => {
      if (a.self.isPinned !== b.self.isPinned) return a.self.isPinned ? -1 : 1;
      const at = a.lastMessage?.createdAt.getTime() ?? a.createdAt.getTime();
      const bt = b.lastMessage?.createdAt.getTime() ?? b.createdAt.getTime();
      return bt - at;
    });
  }

  /** What the conversation list shows for a media message that carries no caption. */
  private preview(type: DirectMessageType, content: string): string {
    if (content) return content;
    switch (type) {
      case DirectMessageType.IMAGE:
        return 'Photo';
      case DirectMessageType.VOICE:
        return 'Voice message';
      case DirectMessageType.VIDEO:
        return 'Video';
      case DirectMessageType.FILE:
        return 'File';
      case DirectMessageType.GIF:
        return 'GIF';
      case DirectMessageType.STICKER:
        return 'Sticker';
      default:
        return '';
    }
  }

  private async invalidateUnread(userId: string): Promise<void> {
    await this.cache.del(chatUnreadKey(userId));
  }
}
