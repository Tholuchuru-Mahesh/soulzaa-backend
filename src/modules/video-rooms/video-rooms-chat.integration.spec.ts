import {
  VideoRoomChatMode,
  VideoRoomMemberRole,
  VideoRoomMessageType,
  VideoRoomStatus,
} from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import { VideoRoomChatPolicyService } from './services/video-room-chat-policy.service';
import { VideoRoomChatService } from './services/video-room-chat.service';

/**
 * VR-9 wiring proof: the send path composed of REAL policy + REAL chat services
 * over mocked I/O. Unit specs prove each gate; this proves they compose in the
 * right order and that a rejection anywhere upstream stops the write.
 */
describe('VR-9 chat integration', () => {
  const ROOM = { id: 'r1', ownerId: 'owner-1', status: VideoRoomStatus.LIVE };
  const SETTINGS = {
    roomId: 'r1',
    allowChat: true,
    allowViewerChat: true,
    chatMode: VideoRoomChatMode.NORMAL,
    chatMaxMessageLength: 500,
    chatMaxAttachments: 1,
    chatRateLimitPerMinute: 20,
    slowModeSeconds: 0,
  };

  let rooms: Record<string, jest.Mock>;
  let permissions: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let repo: Record<string, jest.Mock>;
  let cache: Record<string, jest.Mock>;
  let bus: { publish: jest.Mock };
  let chat: VideoRoomChatService;

  beforeEach(() => {
    rooms = {
      findById: jest.fn().mockResolvedValue(ROOM),
      getSettings: jest.fn().mockResolvedValue(SETTINGS),
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
    };
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    moderation = {
      isActivelyMuted: jest.fn().mockResolvedValue(false),
      isActivelyBlocked: jest.fn().mockResolvedValue(false),
    };
    repo = {
      createMessage: jest.fn().mockResolvedValue({
        id: 'm1',
        roomId: 'r1',
        senderId: 'u1',
        type: VideoRoomMessageType.TEXT,
        content: 'hello',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        metadata: null,
        createdAt: new Date('2026-07-21T00:00:00Z'),
      }),
      findMessage: jest.fn().mockResolvedValue(null),
    };
    cache = { pushRecent: jest.fn() };
    bus = { publish: jest.fn() };

    const config = {
      get: jest.fn().mockReturnValue({
        messageMaxLength: 500,
        maxMentions: 10,
        maxPins: 5,
        rateMax: 20,
        rateWindowSeconds: 60,
        dedupWindowSeconds: 30,
        floodBurstMax: 5,
        floodBurstWindowSeconds: 2,
        cooldownSteps: [10, 30, 120],
        recentBufferSize: 50,
        recentBufferTtlSeconds: 3600,
        typingTtlSeconds: 5,
        recallWindowSeconds: 120,
        editWindowSeconds: 900,
        receiptThrottleMs: 1000,
        systemMessageBroadcastOnlyAboveViewers: 100,
        systemMessageSuppressAboveViewers: 1000,
      }),
    };
    const policy = new VideoRoomChatPolicyService(
      rooms as never,
      permissions as never,
      moderation as never,
      config as never,
    );
    chat = new VideoRoomChatService(
      policy,
      { assertMaySend: jest.fn(), applySlowMode: jest.fn() } as never,
      { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) } as never,
      { resolve: jest.fn().mockResolvedValue({ userIds: [], scope: null }) } as never,
      repo as never,
      cache as never,
      bus as never,
      config as never,
    );
  });

  it('send → persist → cache → broadcast, in that order', async () => {
    await chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' });

    expect(repo.createMessage).toHaveBeenCalled();
    expect(cache.pushRecent).toHaveBeenCalled();
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_sent');
    expect(repo.createMessage.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
  });

  it('a viewer is silenced by PARTICIPANTS_ONLY before anything is written', async () => {
    rooms.getSettings.mockResolvedValue({
      ...SETTINGS,
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
    });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_CHAT_MODE_RESTRICTED });

    expect(repo.createMessage).not.toHaveBeenCalled();
    expect(cache.pushRecent).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('a seated participant still speaks in PARTICIPANTS_ONLY', async () => {
    rooms.getSettings.mockResolvedValue({
      ...SETTINGS,
      chatMode: VideoRoomChatMode.PARTICIPANTS_ONLY,
    });
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.PARTICIPANT);

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).resolves.toBeDefined();
  });

  it('the deprecated allowViewerChat column changes nothing', async () => {
    rooms.getSettings.mockResolvedValue({ ...SETTINGS, allowViewerChat: false });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).resolves.toBeDefined();
  });

  it('a muted member is stopped before the write', async () => {
    moderation.isActivelyMuted.mockResolvedValue(true);

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.MEMBER_MUTED });
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('an ended room refuses chat', async () => {
    rooms.findById.mockResolvedValue({ ...ROOM, status: VideoRoomStatus.ENDED });

    await expect(
      chat.send({ id: 'u1', roles: [] }, 'r1', { content: 'hello' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_ENDED });
  });
});
