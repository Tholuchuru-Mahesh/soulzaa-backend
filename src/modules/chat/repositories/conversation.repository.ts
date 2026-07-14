import { Injectable } from '@nestjs/common';
import {
  Conversation,
  ConversationParticipant,
  ConversationType,
  DirectMessageType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CONVERSATION_PREVIEW_MAX_LENGTH, directPairKey } from '../constants/chat.constants';

/** A conversation with both participant rows loaded — the shape every view needs. */
export type ConversationWithParticipants = Conversation & {
  participants: ConversationParticipant[];
};

/** How the conversation list is filtered for a user (the Chats-screen categories). */
export type ConversationFilter =
  'INBOX' | 'FRIENDS' | 'UNREAD' | 'REQUESTS' | 'ARCHIVED' | 'FAVORITES' | 'BLOCKED';

/**
 * Data layer for conversations and per-user membership state. Pure persistence:
 * permission gating (who may message whom) and view assembly live in the
 * service. Every read is scoped by participant membership, so a caller cannot
 * address a conversation they are not in.
 */
@Injectable()
export class ConversationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Lookup ----

  findById(id: string): Promise<ConversationWithParticipants | null> {
    return this.prisma.conversation.findUnique({
      where: { id },
      include: { participants: true },
    });
  }

  findByPair(userA: string, userB: string): Promise<ConversationWithParticipants | null> {
    return this.prisma.conversation.findUnique({
      where: { pairKey: directPairKey(userA, userB) },
      include: { participants: true },
    });
  }

  /**
   * Open (or resume) the DIRECT conversation between two users. Idempotent by
   * `pairKey`: two devices racing to open the same chat converge on one row
   * rather than creating a duplicate — the unique index is the arbiter, and the
   * losing insert falls back to a read.
   */
  async openDirect(
    creatorId: string,
    peerId: string,
    opts: { asRequest: boolean },
  ): Promise<ConversationWithParticipants> {
    const pairKey = directPairKey(creatorId, peerId);
    try {
      return await this.prisma.conversation.create({
        data: {
          type: ConversationType.DIRECT,
          pairKey,
          createdBy: creatorId,
          requestedBy: opts.asRequest ? creatorId : null,
          acceptedAt: opts.asRequest ? null : new Date(),
          participants: {
            create: [{ userId: creatorId }, { userId: peerId }],
          },
        },
        include: { participants: true },
      });
    } catch (e) {
      // Lost the race — the peer (or this user's other device) created it first.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.findByPair(creatorId, peerId);
        if (existing) return existing;
      }
      throw e;
    }
  }

  // ---- List ----

  /**
   * A page of the user's conversations, newest activity first.
   *
   * Supports keyset pagination via `cursor` (the last conversation id of the
   * previous page). Keyset is the only mode that stays correct here: conversations
   * re-sort to the top the moment a message lands, so an offset window would shift
   * under the user mid-scroll and hand back rows they already have. When a cursor
   * is supplied, `skip` is ignored.
   *
   * `search` matches the peer's username/full name, so the peer ids are resolved by
   * the caller and passed in as `peerIdFilter` — this repository never reaches into
   * the users tables. Same for `friendIds` / `blockedIds`, which come from the
   * social and privacy modules through their service contracts.
   */
  async list(
    userId: string,
    opts: {
      filter: ConversationFilter;
      skip: number;
      take: number;
      peerIdFilter?: string[];
      friendIds?: string[];
      blockedIds?: string[];
      cursor?: string;
    },
  ): Promise<[ConversationWithParticipants[], number]> {
    const where = this.listWhere(userId, opts);
    const keyset = opts.cursor ? await this.cursorClause(opts.cursor) : undefined;
    const paged: Prisma.ConversationWhereInput = keyset ? { AND: [where, keyset] } : where;

    return this.prisma.$transaction([
      this.prisma.conversation.findMany({
        where: paged,
        include: { participants: true },
        // A cursor already anchors the window; skipping on top would double-advance it.
        ...(opts.cursor ? {} : { skip: opts.skip }),
        take: opts.take,
        orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      }),
      this.prisma.conversation.count({ where }),
    ]);
  }

  /**
   * Everything strictly "after" the cursor row in `(lastMessageAt desc, id desc)`
   * order. The id tiebreak matters: conversations created in the same millisecond,
   * or several with no messages at all (`lastMessageAt` null), would otherwise have
   * no stable order and the cursor could loop or skip.
   */
  private async cursorClause(cursorId: string): Promise<Prisma.ConversationWhereInput | undefined> {
    const anchor = await this.prisma.conversation.findUnique({
      where: { id: cursorId },
      select: { id: true, lastMessageAt: true },
    });
    if (!anchor) return undefined;

    if (anchor.lastMessageAt === null) {
      // The anchor is in the null-tail; only other null-tail rows with a smaller id remain.
      return { lastMessageAt: null, id: { lt: anchor.id } };
    }

    return {
      OR: [
        { lastMessageAt: { lt: anchor.lastMessageAt } },
        { lastMessageAt: anchor.lastMessageAt, id: { lt: anchor.id } },
        { lastMessageAt: null },
      ],
    };
  }

  /**
   * Pinned conversations sort above everything else. Prisma cannot order by a
   * column on a filtered relation, so pinning is applied as a separate ordered
   * read that the service prepends on page 1 — keeping the main query on its
   * `(userId, isArchived, leftAt)` index instead of forcing a join-sort.
   */
  pinned(userId: string): Promise<ConversationWithParticipants[]> {
    return this.prisma.conversation.findMany({
      where: {
        participants: { some: { userId, isPinned: true, isArchived: false, leftAt: null } },
        acceptedAt: { not: null },
      },
      include: { participants: true },
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }],
    });
  }

  /** How many conversations this user currently has pinned (for the pin limit). */
  countPinned(userId: string): Promise<number> {
    return this.prisma.conversationParticipant.count({
      where: { userId, isPinned: true, leftAt: null },
    });
  }

  private listWhere(
    userId: string,
    opts: {
      filter: ConversationFilter;
      peerIdFilter?: string[];
      friendIds?: string[];
      blockedIds?: string[];
    },
  ): Prisma.ConversationWhereInput {
    const mine: Prisma.ConversationParticipantWhereInput = { userId, leftAt: null };

    // Accepted, non-archived — the baseline every category except REQUESTS/ARCHIVED
    // narrows further.
    const active: Prisma.ConversationWhereInput = {
      acceptedAt: { not: null },
      participants: { some: { ...mine, isArchived: false } },
    };

    let base: Prisma.ConversationWhereInput;

    switch (opts.filter) {
      case 'REQUESTS':
        // Inbound only: someone else asked, and it is still unaccepted.
        base = {
          acceptedAt: null,
          requestedBy: { not: userId },
          participants: { some: mine },
        };
        break;

      case 'ARCHIVED':
        base = {
          acceptedAt: { not: null },
          participants: { some: { ...mine, isArchived: true } },
        };
        break;

      case 'FAVORITES':
        base = {
          acceptedAt: { not: null },
          participants: { some: { ...mine, isFavorite: true, isArchived: false } },
        };
        break;

      case 'UNREAD':
        // "Mark as unread" counts as unread even though the read watermark moved.
        base = {
          acceptedAt: { not: null },
          participants: {
            some: {
              ...mine,
              isArchived: false,
              OR: [{ unreadCount: { gt: 0 } }, { manualUnread: true }],
            },
          },
        };
        break;

      case 'FRIENDS':
        base = {
          AND: [active, { participants: { some: { userId: { in: opts.friendIds ?? [] } } } }],
        };
        break;

      case 'BLOCKED':
        base = {
          AND: [
            { acceptedAt: { not: null }, participants: { some: mine } },
            { participants: { some: { userId: { in: opts.blockedIds ?? [] } } } },
          ],
        };
        break;

      case 'INBOX':
      default:
        base = active;
        break;
    }

    return opts.peerIdFilter
      ? { AND: [base, { participants: { some: { userId: { in: opts.peerIdFilter } } } }] }
      : base;
  }

  // ---- Participant state ----

  participant(conversationId: string, userId: string): Promise<ConversationParticipant | null> {
    return this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
  }

  updateParticipant(
    conversationId: string,
    userId: string,
    data: Prisma.ConversationParticipantUpdateInput,
  ): Promise<ConversationParticipant> {
    return this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data,
    });
  }

  // ---- Pinned thread banner ----

  /**
   * Set (or clear) the message pinned to the top of the thread.
   *
   * Single-slot: pinning replaces whatever was pinned before. This is the *shared*
   * pin both participants see — not `ConversationParticipant.isPinned`, which pins
   * the conversation in one user's Chats list.
   */
  setPinnedMessage(
    conversationId: string,
    pin: { messageId: string; pinnedBy: string } | null,
  ): Promise<ConversationWithParticipants> {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: pin
        ? { pinnedMessageId: pin.messageId, pinnedBy: pin.pinnedBy, pinnedAt: new Date() }
        : { pinnedMessageId: null, pinnedBy: null, pinnedAt: null },
      include: { participants: true },
    });
  }

  /**
   * Advance a watermark, never rewind it. Guarding on the timestamp makes the
   * write idempotent and immune to out-of-order receipts — a late "read up to an
   * older message" from a slow device cannot un-read newer messages. Returns
   * false when the watermark was already at or past `at`.
   */
  async advanceReadWatermark(
    conversationId: string,
    userId: string,
    messageId: string,
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId,
        OR: [{ lastReadMessageAt: null }, { lastReadMessageAt: { lt: at } }],
      },
      data: {
        lastReadMessageId: messageId,
        lastReadMessageAt: at,
        unreadCount: 0,
      },
    });
    return count > 0;
  }

  async advanceDeliveredWatermark(
    conversationId: string,
    userId: string,
    messageId: string,
    at: Date,
  ): Promise<boolean> {
    const { count } = await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId,
        userId,
        OR: [{ lastDeliveredMessageAt: null }, { lastDeliveredMessageAt: { lt: at } }],
      },
      data: { lastDeliveredMessageId: messageId, lastDeliveredMessageAt: at },
    });
    return count > 0;
  }

  /** Bump unread for everyone in the conversation except the sender. */
  incrementUnreadForPeers(conversationId: string, senderId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.conversationParticipant.updateMany({
      where: { conversationId, userId: { not: senderId }, leftAt: null },
      data: { unreadCount: { increment: 1 } },
    });
  }

  // ---- Mutations ----

  /** Denormalise the newest message onto the conversation for the list preview. */
  touchLastMessage(
    conversationId: string,
    message: { id: string; senderId: string; type: DirectMessageType; createdAt: Date },
    preview: string,
  ): Promise<Conversation> {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageId: message.id,
        lastMessageAt: message.createdAt,
        lastMessageSender: message.senderId,
        lastMessageType: message.type,
        lastMessagePreview: preview.slice(0, CONVERSATION_PREVIEW_MAX_LENGTH),
      },
    });
  }

  accept(conversationId: string): Promise<Conversation> {
    return this.prisma.conversation.update({
      where: { id: conversationId },
      data: { acceptedAt: new Date() },
    });
  }

  /** Count of pending inbound chat requests — the Requests tab badge. */
  countInboundRequests(userId: string): Promise<number> {
    return this.prisma.conversation.count({
      where: {
        acceptedAt: null,
        requestedBy: { not: userId },
        participants: { some: { userId, leftAt: null } },
      },
    });
  }

  /**
   * Unread totals across accepted, unarchived conversations — the tab badge.
   * A conversation the user explicitly marked unread counts as one unread message,
   * so the badge agrees with what the list row shows.
   */
  async unreadTotals(userId: string): Promise<{ total: number; conversations: number }> {
    const rows = await this.prisma.conversationParticipant.findMany({
      where: {
        userId,
        leftAt: null,
        isArchived: false,
        conversation: { acceptedAt: { not: null } },
        OR: [{ unreadCount: { gt: 0 } }, { manualUnread: true }],
      },
      select: { unreadCount: true, manualUnread: true },
    });
    return {
      total: rows.reduce((sum, r) => sum + Math.max(r.unreadCount, r.manualUnread ? 1 : 0), 0),
      conversations: rows.length,
    };
  }

  /**
   * Restore the unread badge without touching the read watermark.
   *
   * Rewinding the watermark would flip the peer's blue ticks back to grey — telling
   * them their message was never read, when it was. The badge is this user's own
   * bookkeeping; the receipt is a promise already made to someone else.
   */
  markUnread(conversationId: string, userId: string): Promise<ConversationParticipant> {
    return this.prisma.conversationParticipant.update({
      where: { conversationId_userId: { conversationId, userId } },
      data: { manualUnread: true, unreadCount: { set: 1 } },
    });
  }

  /** Badge counts for every category chip, in one round trip. */
  async categoryCounts(
    userId: string,
    opts: { friendIds: string[]; blockedIds: string[] },
  ): Promise<{
    all: number;
    friends: number;
    unread: number;
    requests: number;
    archived: number;
    favorites: number;
    blocked: number;
  }> {
    const mine = { userId, leftAt: null } as const;
    const accepted = { acceptedAt: { not: null } } as const;

    const [all, friends, unread, requests, archived, favorites, blocked] =
      await this.prisma.$transaction([
        this.prisma.conversation.count({
          where: { ...accepted, participants: { some: { ...mine, isArchived: false } } },
        }),
        this.prisma.conversation.count({
          where: {
            AND: [
              { ...accepted, participants: { some: { ...mine, isArchived: false } } },
              { participants: { some: { userId: { in: opts.friendIds } } } },
            ],
          },
        }),
        this.prisma.conversation.count({
          where: {
            ...accepted,
            participants: {
              some: {
                ...mine,
                isArchived: false,
                OR: [{ unreadCount: { gt: 0 } }, { manualUnread: true }],
              },
            },
          },
        }),
        this.prisma.conversation.count({
          where: {
            acceptedAt: null,
            requestedBy: { not: userId },
            participants: { some: mine },
          },
        }),
        this.prisma.conversation.count({
          where: { ...accepted, participants: { some: { ...mine, isArchived: true } } },
        }),
        this.prisma.conversation.count({
          where: {
            ...accepted,
            participants: { some: { ...mine, isFavorite: true, isArchived: false } },
          },
        }),
        this.prisma.conversation.count({
          where: {
            AND: [
              { ...accepted, participants: { some: mine } },
              { participants: { some: { userId: { in: opts.blockedIds } } } },
            ],
          },
        }),
      ]);

    return { all, friends, unread, requests, archived, favorites, blocked };
  }
}
