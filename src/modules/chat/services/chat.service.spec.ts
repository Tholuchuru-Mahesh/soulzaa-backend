import { AttachmentType, DirectMessageType, ReportReason } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { CacheService } from 'src/infra/redis/cache.service';
import { PrivacyAction } from 'src/modules/privacy/interfaces/privacy.interface';
import { ConversationRepository } from '../repositories/conversation.repository';
import { MessageRepository } from '../repositories/message.repository';
import { ChatService } from './chat.service';
import { ChatViewMapper } from './chat-view.mapper';

const ME = 'user-a';
const PEER = 'user-b';
const CONV = 'conv-1';

/** A participant row with every column the view mapper reads. */
function participant(userId: string, over: Record<string, unknown> = {}) {
  return {
    conversationId: CONV,
    userId,
    leftAt: null,
    isMuted: false,
    isPinned: false,
    isArchived: false,
    isFavorite: false,
    manualUnread: false,
    unreadCount: 0,
    mutedUntil: null,
    draft: null,
    lastReadMessageId: null,
    lastReadMessageAt: null,
    lastDeliveredMessageAt: null,
    clearedAt: null,
    ...over,
  };
}

/** A conversation row with both participants, as the repository returns it. */
function conversation(over: Record<string, unknown> = {}) {
  return {
    id: CONV,
    type: 'DIRECT',
    pairKey: `${ME}:${PEER}`,
    createdBy: ME,
    requestedBy: null,
    acceptedAt: new Date('2026-01-01'),
    lastMessageId: null,
    lastMessageAt: null,
    lastMessagePreview: null,
    lastMessageType: null,
    lastMessageSender: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    participants: [participant(ME), participant(PEER)],
    ...over,
  };
}

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    conversationId: CONV,
    senderId: ME,
    type: DirectMessageType.TEXT,
    content: 'hi',
    clientId: 'client-1',
    replyToId: null,
    isDeleted: false,
    deletedAt: null,
    editedAt: null,
    metadata: null,
    createdAt: new Date('2026-01-02'),
    attachments: [],
    reactions: [],
    ...over,
  };
}

describe('ChatService', () => {
  let conversations: Record<string, jest.Mock>;
  let messages: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let privacy: Record<string, jest.Mock>;
  let relationships: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let social: Record<string, jest.Mock>;
  let service: ChatService;

  const config = {
    get: jest.fn().mockReturnValue({
      messageMaxLength: 4000,
      maxAttachments: 10,
      rateMax: 30,
      rateWindowSeconds: 10,
      typingTtlSeconds: 5,
      unreadCacheTtlSeconds: 60,
      editWindowSeconds: 900,
      maxPinned: 5,
    }),
  };

  beforeEach(() => {
    conversations = {
      findById: jest.fn().mockResolvedValue(conversation()),
      findByPair: jest.fn().mockResolvedValue(null),
      openDirect: jest.fn().mockResolvedValue(conversation()),
      list: jest.fn().mockResolvedValue([[], 0]),
      participant: jest
        .fn()
        .mockResolvedValue({ clearedAt: null, isPinned: false, manualUnread: false }),
      updateParticipant: jest.fn().mockResolvedValue({
        isPinned: true,
        isArchived: false,
        isFavorite: false,
        isMuted: false,
        mutedUntil: null,
      }),
      advanceReadWatermark: jest.fn().mockResolvedValue(true),
      advanceDeliveredWatermark: jest.fn().mockResolvedValue(true),
      incrementUnreadForPeers: jest.fn().mockResolvedValue({ count: 1 }),
      touchLastMessage: jest.fn().mockResolvedValue(undefined),
      accept: jest.fn().mockResolvedValue(undefined),
      countInboundRequests: jest.fn().mockResolvedValue(0),
      unreadTotals: jest.fn().mockResolvedValue({ total: 0, conversations: 0 }),
      countPinned: jest.fn().mockResolvedValue(0),
      markUnread: jest.fn().mockResolvedValue({
        isPinned: false,
        isArchived: false,
        isFavorite: false,
        isMuted: false,
        mutedUntil: null,
      }),
      categoryCounts: jest.fn().mockResolvedValue({
        all: 1,
        friends: 0,
        unread: 0,
        requests: 0,
        archived: 0,
        favorites: 0,
        blocked: 0,
      }),
    };

    messages = {
      create: jest.fn().mockResolvedValue({ message: message(), created: true }),
      findById: jest.fn().mockResolvedValue(message()),
      findByClientId: jest.fn().mockResolvedValue(null),
      list: jest.fn().mockResolvedValue([[], 0]),
      softDelete: jest.fn().mockResolvedValue(undefined),
      addReaction: jest.fn().mockResolvedValue(true),
      removeReaction: jest.fn().mockResolvedValue(true),
      bumpSendRate: jest.fn().mockResolvedValue(1),
      edit: jest.fn().mockResolvedValue(message({ content: 'fixed', editedAt: new Date() })),
      createReport: jest.fn().mockResolvedValue({ id: 'report-1' }),
    };

    cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() } as never;
    privacy = {
      check: jest.fn().mockResolvedValue(true),
      listBlocked: jest.fn().mockResolvedValue([]),
    };
    relationships = { isFriend: jest.fn().mockResolvedValue(true), isFollower: jest.fn() };
    social = {
      friendIds: jest.fn().mockResolvedValue([]),
      followerIds: jest.fn(),
      presenceAudienceIds: jest.fn(),
    };
    profiles = {
      getCards: jest.fn().mockResolvedValue([
        {
          id: PEER,
          username: 'peer',
          fullName: 'Peer',
          avatarUrl: null,
          verified: false,
          level: 1,
          vipLevel: 0,
        },
        {
          id: ME,
          username: 'me',
          fullName: 'Me',
          avatarUrl: null,
          verified: false,
          level: 1,
          vipLevel: 0,
        },
      ]),
      search: jest
        .fn()
        .mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
    };

    // No CDN base in tests, and no S3 — the resolver is stubbed to echo the key
    // back as a URL, which is all the view assertions need.
    const mediaUrls = {
      isStable: true,
      resolve: jest.fn(async (key: string | null) => (key ? `https://cdn.test/${key}` : null)),
    };

    const views = new ChatViewMapper(profiles as never, mediaUrls as never);

    service = new ChatService(
      conversations as unknown as ConversationRepository,
      messages as unknown as MessageRepository,
      views,
      cache as unknown as CacheService,
      config as never,
      bus,
      privacy as never,
      relationships as never,
      profiles as never,
      social as never,
    );
  });

  // ---------------------------------------------------------------- open

  describe('openDirect', () => {
    it('refuses to open a conversation with yourself', async () => {
      await expect(service.openDirect(ME, ME)).rejects.toThrow(BusinessException);
    });

    it('opens directly (already accepted) when the users are friends', async () => {
      relationships.isFriend.mockResolvedValue(true);
      await service.openDirect(ME, PEER);
      expect(conversations.openDirect).toHaveBeenCalledWith(ME, PEER, { asRequest: false });
    });

    it('opens as a REQUEST when the users are not friends', async () => {
      relationships.isFriend.mockResolvedValue(false);
      conversations.openDirect.mockResolvedValue(
        conversation({ requestedBy: ME, acceptedAt: null }),
      );
      await service.openDirect(ME, PEER);
      expect(conversations.openDirect).toHaveBeenCalledWith(ME, PEER, { asRequest: true });
    });

    it('resumes the existing conversation instead of creating a second one', async () => {
      conversations.findByPair.mockResolvedValue(conversation());
      const view = await service.openDirect(ME, PEER);
      expect(conversations.openDirect).not.toHaveBeenCalled();
      expect(view.id).toBe(CONV);
    });

    it('is blocked by the privacy gate (PrivacyAction.MESSAGE)', async () => {
      privacy.check.mockResolvedValue(false);
      await expect(service.openDirect(ME, PEER)).rejects.toThrow(BusinessException);
      expect(privacy.check).toHaveBeenCalledWith(ME, PEER, PrivacyAction.MESSAGE);
    });
  });

  // ---------------------------------------------------------------- send

  describe('sendMessage', () => {
    const input = { clientId: 'client-1', type: DirectMessageType.TEXT, content: 'hi' };

    it('re-checks the privacy gate on every send, not just at open', async () => {
      privacy.check.mockResolvedValue(false);
      await expect(service.sendMessage(ME, CONV, input)).rejects.toThrow(BusinessException);
    });

    it('runs the side effects exactly once for a new message', async () => {
      await service.sendMessage(ME, CONV, input);
      expect(conversations.incrementUnreadForPeers).toHaveBeenCalledTimes(1);
      expect(conversations.touchLastMessage).toHaveBeenCalledTimes(1);
      expect(bus.publish).toHaveBeenCalledTimes(1);
    });

    it('skips the side effects when a retry resolves to an existing message', async () => {
      // The idempotency path: same clientId, row already existed.
      messages.create.mockResolvedValue({ message: message(), created: false });
      const view = await service.sendMessage(ME, CONV, input);

      expect(view.id).toBe('msg-1');
      // Without this, one flaky network would double the peer's unread count
      // and fire a second push for a message they already have.
      expect(conversations.incrementUnreadForPeers).not.toHaveBeenCalled();
      expect(conversations.touchLastMessage).not.toHaveBeenCalled();
      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('does not notify a peer who muted the conversation', async () => {
      conversations.findById.mockResolvedValue(
        conversation({
          participants: [participant(ME), participant(PEER, { isMuted: true })],
        }),
      );
      await service.sendMessage(ME, CONV, input);

      const event = bus.publish.mock.calls[0][0] as {
        payload: { notifyIds: string[]; recipientIds: string[] };
      };
      expect(event.payload.notifyIds).toEqual([]);
      // Muted still delivers in realtime — it just doesn't buzz the phone.
      expect(event.payload.recipientIds).toContain(PEER);
    });

    it('rejects an empty text message', async () => {
      await expect(service.sendMessage(ME, CONV, { ...input, content: '   ' })).rejects.toThrow(
        BusinessException,
      );
    });

    it('rejects a media message with no attachment', async () => {
      await expect(
        service.sendMessage(ME, CONV, { ...input, type: DirectMessageType.IMAGE, content: '' }),
      ).rejects.toThrow(BusinessException);
    });

    it('rejects an attachment whose kind contradicts the message type', async () => {
      await expect(
        service.sendMessage(ME, CONV, {
          ...input,
          type: DirectMessageType.IMAGE,
          content: '',
          attachments: [
            {
              type: AttachmentType.VOICE,
              storageKey: 'chat-voice/x.m4a',
              mimeType: 'audio/mp4',
              sizeBytes: 1,
            },
          ],
        }),
      ).rejects.toThrow(BusinessException);
    });

    it('rate-limits a sender over the ceiling', async () => {
      messages.bumpSendRate.mockResolvedValue(31); // rateMax = 30
      await expect(service.sendMessage(ME, CONV, input)).rejects.toThrow(BusinessException);
    });
  });

  // ------------------------------------------------------------- requests

  describe('chat requests', () => {
    const pending = () => conversation({ requestedBy: PEER, acceptedAt: null });

    it('blocks the recipient from replying before they accept', async () => {
      conversations.findById.mockResolvedValue(pending());
      await expect(
        service.sendMessage(ME, CONV, {
          clientId: 'c',
          type: DirectMessageType.TEXT,
          content: 'hi',
        }),
      ).rejects.toThrow(BusinessException);
    });

    it('lets the requester keep writing into their own pending request', async () => {
      conversations.findById.mockResolvedValue(conversation({ requestedBy: ME, acceptedAt: null }));
      await expect(
        service.sendMessage(ME, CONV, {
          clientId: 'c',
          type: DirectMessageType.TEXT,
          content: 'hi',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts an inbound request', async () => {
      conversations.findById.mockResolvedValue(pending());
      await service.acceptRequest(ME, CONV);
      expect(conversations.accept).toHaveBeenCalledWith(CONV);
    });

    it('refuses to accept a conversation that is not a pending inbound request', async () => {
      conversations.findById.mockResolvedValue(conversation()); // already accepted
      await expect(service.acceptRequest(ME, CONV)).rejects.toThrow(BusinessException);
    });

    it('refuses to accept your OWN outbound request', async () => {
      conversations.findById.mockResolvedValue(conversation({ requestedBy: ME, acceptedAt: null }));
      await expect(service.acceptRequest(ME, CONV)).rejects.toThrow(BusinessException);
    });
  });

  // ------------------------------------------------------------- receipts

  describe('markRead', () => {
    it('publishes and busts the badge when the watermark advances', async () => {
      conversations.advanceReadWatermark.mockResolvedValue(true);
      await service.markRead(ME, CONV, 'msg-1');
      expect(bus.publish).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalled();
    });

    it('stays silent when the watermark did not move (stale receipt)', async () => {
      // A slow device re-reporting an older message must not un-read newer ones,
      // re-broadcast, or churn the cache.
      conversations.advanceReadWatermark.mockResolvedValue(false);
      await service.markRead(ME, CONV, 'msg-1');
      expect(bus.publish).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    it('rejects a message id that belongs to another conversation', async () => {
      messages.findById.mockResolvedValue(message({ conversationId: 'other-conv' }));
      await expect(service.markRead(ME, CONV, 'msg-1')).rejects.toThrow(BusinessException);
    });
  });

  // -------------------------------------------------------------- access

  describe('participation guard', () => {
    it('rejects a non-participant', async () => {
      conversations.findById.mockResolvedValue(
        conversation({
          participants: [
            {
              conversationId: CONV,
              userId: 'someone',
              leftAt: null,
              isMuted: false,
              unreadCount: 0,
            },
            { conversationId: CONV, userId: 'else', leftAt: null, isMuted: false, unreadCount: 0 },
          ],
        }),
      );
      await expect(service.getConversation(ME, CONV)).rejects.toThrow(BusinessException);
    });

    it('rejects a missing conversation', async () => {
      conversations.findById.mockResolvedValue(null);
      await expect(service.getConversation(ME, CONV)).rejects.toThrow(BusinessException);
    });
  });

  describe('deleteMessage', () => {
    it("refuses to delete someone else's message", async () => {
      messages.findById.mockResolvedValue(message({ senderId: PEER }));
      await expect(service.deleteMessage(ME, 'msg-1')).rejects.toThrow(BusinessException);
      expect(messages.softDelete).not.toHaveBeenCalled();
    });

    it('soft-deletes your own message', async () => {
      await service.deleteMessage(ME, 'msg-1');
      expect(messages.softDelete).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('react', () => {
    it('is a no-op when the same emoji is applied twice', async () => {
      messages.addReaction.mockResolvedValue(false);
      await service.react(ME, 'msg-1', '❤️');
      expect(bus.publish).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------- part 2

  describe('pin limit', () => {
    it('refuses a NEW pin past the ceiling', async () => {
      conversations.countPinned.mockResolvedValue(5); // maxPinned = 5
      await expect(service.updateSettings(ME, CONV, { isPinned: true })).rejects.toThrow(
        BusinessException,
      );
    });

    it('allows re-pinning something already pinned (the limit must not block a no-op)', async () => {
      conversations.participant.mockResolvedValue({ clearedAt: null, isPinned: true });
      conversations.countPinned.mockResolvedValue(5);
      await expect(service.updateSettings(ME, CONV, { isPinned: true })).resolves.toBeDefined();
    });

    it('never blocks an UNPIN, even at the ceiling', async () => {
      conversations.countPinned.mockResolvedValue(99);
      await expect(service.updateSettings(ME, CONV, { isPinned: false })).resolves.toBeDefined();
      expect(conversations.countPinned).not.toHaveBeenCalled();
    });
  });

  describe('markUnread', () => {
    it('restores the badge WITHOUT rewinding the read watermark', async () => {
      await service.markUnread(ME, CONV);

      expect(conversations.markUnread).toHaveBeenCalledWith(CONV, ME);
      // The peer's blue ticks were earned — this must never retract them.
      expect(conversations.advanceReadWatermark).not.toHaveBeenCalled();
      expect(conversations.updateParticipant).not.toHaveBeenCalledWith(
        CONV,
        ME,
        expect.objectContaining({ lastReadMessageAt: expect.anything() }),
      );
    });
  });

  describe('markRead clears an explicit mark-unread', () => {
    it('drops the flag when the user opens the chat again', async () => {
      conversations.participant.mockResolvedValue({ clearedAt: null, manualUnread: true });
      await service.markRead(ME, CONV, 'msg-1');
      expect(conversations.updateParticipant).toHaveBeenCalledWith(
        CONV,
        ME,
        expect.objectContaining({ manualUnread: false, unreadCount: 0 }),
      );
    });
  });

  describe('editMessage', () => {
    it("refuses to edit someone else's message", async () => {
      messages.findById.mockResolvedValue(message({ senderId: PEER }));
      await expect(service.editMessage(ME, 'msg-1', 'nope')).rejects.toThrow(BusinessException);
    });

    it('refuses once the edit window has closed', async () => {
      // editWindowSeconds = 900; this message is an hour old.
      messages.findById.mockResolvedValue(message({ createdAt: new Date(Date.now() - 3_600_000) }));
      await expect(service.editMessage(ME, 'msg-1', 'too late')).rejects.toThrow(BusinessException);
    });

    it('edits a fresh message and broadcasts it', async () => {
      messages.findById.mockResolvedValue(message({ createdAt: new Date() }));
      const view = await service.editMessage(ME, 'msg-1', 'fixed');
      expect(view.content).toBe('fixed');
      expect(messages.edit).toHaveBeenCalledWith('msg-1', 'fixed');
      expect(bus.publish).toHaveBeenCalled();
    });

    it('refuses an empty edit', async () => {
      messages.findById.mockResolvedValue(message({ createdAt: new Date() }));
      await expect(service.editMessage(ME, 'msg-1', '   ')).rejects.toThrow(BusinessException);
    });
  });

  describe('rich message types', () => {
    it('rejects a GIFT with no giftId in metadata', async () => {
      await expect(
        service.sendMessage(ME, CONV, {
          clientId: 'c',
          type: DirectMessageType.GIFT,
          content: '',
        }),
      ).rejects.toThrow(BusinessException);
    });

    it('accepts a GIFT that names its gift', async () => {
      await expect(
        service.sendMessage(ME, CONV, {
          clientId: 'c',
          type: DirectMessageType.GIFT,
          content: '',
          metadata: { giftId: 'gift-1' },
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a ROOM_INVITE with no roomId', async () => {
      await expect(
        service.sendMessage(ME, CONV, {
          clientId: 'c',
          type: DirectMessageType.ROOM_INVITE,
          content: '',
          metadata: { somethingElse: 'x' },
        }),
      ).rejects.toThrow(BusinessException);
    });
  });

  describe('report', () => {
    it('files a report against the peer', async () => {
      const result = await service.report(ME, CONV, { reason: ReportReason.HARASSMENT });
      expect(result.reportId).toBe('report-1');
      expect(messages.createReport).toHaveBeenCalledWith(
        expect.objectContaining({ reporterId: ME, targetUserId: PEER }),
      );
    });

    it('rejects a report naming a message from another conversation', async () => {
      messages.findById.mockResolvedValue(message({ conversationId: 'other' }));
      await expect(
        service.report(ME, CONV, { reason: ReportReason.SPAM, messageId: 'msg-1' }),
      ).rejects.toThrow(BusinessException);
    });
  });

  describe('unreadTotal', () => {
    it('serves the cached badge without touching the database', async () => {
      cache.get.mockResolvedValue({ total: 7, conversations: 2, requests: 1 });
      const view = await service.unreadTotal(ME);
      expect(view.total).toBe(7);
      expect(conversations.unreadTotals).not.toHaveBeenCalled();
    });
  });
});
