import { BlockedWordAction, BlockedWordSeverity, ChatMessageType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { QueueService } from 'src/infra/queue/queue.service';
import { LockService } from 'src/infra/redis/lock.service';
import type { IUsersService } from 'src/modules/users/interfaces/users.service.interface';
import type { IProfileService } from 'src/modules/users/interfaces/profile.interface';
import type { SendMessageDto } from '../dto/chat.dto';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { AudioRoomSeatsRepository } from '../repositories/audio-room-seats.repository';
import { AudioRoomsRepository } from '../repositories/audio-rooms.repository';
import { ChatRepository } from '../repositories/chat.repository';
import { ModerationRepository } from '../repositories/moderation.repository';
import { BlockedWordService } from 'src/infra/content-moderation';
import { ChatService } from './chat.service';
import { ModerationService } from './moderation.service';
import { RoomPermissionService } from './room-permission.service';

const ACTOR: RoomActor = { id: 'user-1', roles: ['USER'] };
const ROOM = 'room-1';

const CHAT_CFG = {
  messageMaxLength: 1000,
  maxMentions: 10,
  maxPins: 5,
  rateMax: 10,
  rateWindowSeconds: 10,
  dedupWindowSeconds: 30,
  reactRateMax: 15,
  reactRateWindowSeconds: 10,
  violationWindowSeconds: 3600,
  autoMuteThreshold: 3,
  autoKickThreshold: 6,
  autoMuteMinutes: 15,
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    roomId: ROOM,
    senderId: ACTOR.id,
    type: ChatMessageType.TEXT,
    content: 'hello',
    gifUrl: null,
    mentions: [],
    replyToId: null,
    isDeleted: false,
    deletedBy: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function sendDto(overrides: Partial<SendMessageDto> = {}): SendMessageDto {
  return { type: ChatMessageType.TEXT, content: 'hello world', ...overrides } as SendMessageDto;
}

describe('ChatService', () => {
  let chatRepo: Record<string, jest.Mock>;
  let blockedWords: { scan: jest.Mock; invalidate: jest.Mock };
  let permissions: Record<string, jest.Mock>;
  let moderation: Record<string, jest.Mock>;
  let modRepo: Record<string, jest.Mock>;
  let rooms: Record<string, jest.Mock>;
  let seats: Record<string, jest.Mock>;
  let locks: { withLock: jest.Mock };
  let config: { get: jest.Mock };
  let queue: { enqueue: jest.Mock };
  let bus: jest.Mocked<IEventBus>;
  let users: Record<string, jest.Mock>;
  let liveSessions: Record<string, jest.Mock>;
  let profiles: Record<string, jest.Mock>;
  let service: ChatService;

  beforeEach(() => {
    chatRepo = {
      hitRateLimit: jest.fn().mockResolvedValue(false),
      hitReactRateLimit: jest.fn().mockResolvedValue(false),
      isSlowModeActive: jest.fn().mockResolvedValue(false),
      isDuplicate: jest.fn().mockResolvedValue(false),
      setSlowMode: jest.fn().mockResolvedValue(undefined),
      incrViolation: jest.fn().mockResolvedValue(1),
      createMessage: jest.fn().mockImplementation((d) => Promise.resolve(message(d))),
      getMessage: jest.fn(),
      listMessages: jest.fn().mockResolvedValue([[], 0]),
      softDeleteMessage: jest.fn().mockResolvedValue(undefined),
      pin: jest.fn().mockResolvedValue({ id: 'pin-1' }),
      getActivePin: jest.fn().mockResolvedValue(null),
      countActivePins: jest.fn().mockResolvedValue(0),
      listActivePins: jest.fn().mockResolvedValue([]),
      unpin: jest.fn().mockResolvedValue(undefined),
      createReport: jest.fn().mockResolvedValue({ id: 'creport-1' }),
      getReport: jest.fn(),
      findOpenReport: jest.fn().mockResolvedValue(null),
      listReports: jest.fn().mockResolvedValue([[], 0]),
      reviewReport: jest.fn().mockResolvedValue(undefined),
    };
    blockedWords = {
      scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: 'hello world' }),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    permissions = {
      assertPermission: jest.fn().mockResolvedValue(undefined),
      assertCanModerate: jest.fn().mockResolvedValue(undefined),
      canModerate: jest.fn().mockResolvedValue(false),
    };
    moderation = {
      assertNotBanned: jest.fn().mockResolvedValue(undefined),
      isMuted: jest.fn().mockResolvedValue(false),
      autoMute: jest.fn().mockResolvedValue(undefined),
      autoKick: jest.fn().mockResolvedValue(undefined),
    };
    modRepo = {
      appendAction: jest.fn().mockResolvedValue(undefined),
      createReport: jest.fn().mockResolvedValue({ id: 'report-1' }),
    };
    rooms = {
      getMember: jest.fn().mockResolvedValue({ isActive: true }),
      findLiveRoomRow: jest.fn().mockResolvedValue({ id: ROOM }),
      findRoomRow: jest.fn().mockResolvedValue({ id: ROOM, status: 'LIVE', createdAt: new Date() }),
      getSettings: jest.fn().mockResolvedValue({ allowChat: true, chatSlowModeSeconds: 0 }),
      getOwnerId: jest.fn().mockResolvedValue('owner-1'),
    };
    seats = {
      listElevatedMemberIds: jest.fn().mockResolvedValue(['owner-1']),
      getSeatByOccupant: jest.fn().mockResolvedValue(null),
    };
    locks = { withLock: jest.fn(<T>(_k: string, fn: () => Promise<T>) => fn()) };
    config = { get: jest.fn().mockReturnValue({ chat: CHAT_CFG }) };
    queue = { enqueue: jest.fn().mockResolvedValue(undefined) };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    users = { findByUsername: jest.fn().mockResolvedValue(null) };
    liveSessions = {
      getOpenSession: jest.fn().mockResolvedValue({ id: 'session-1', startedAt: new Date() }),
    };
    profiles = {
      resolvePublicIdentities: jest.fn().mockResolvedValue(new Map()),
    };

    service = new ChatService(
      chatRepo as unknown as ChatRepository,
      blockedWords as unknown as BlockedWordService,
      permissions as unknown as RoomPermissionService,
      moderation as unknown as ModerationService,
      modRepo as unknown as ModerationRepository,
      rooms as unknown as AudioRoomsRepository,
      seats as unknown as AudioRoomSeatsRepository,
      locks as unknown as LockService,
      config as unknown as ConfigService,
      queue as unknown as QueueService,
      bus,
      users as unknown as IUsersService,
      liveSessions as any,
      profiles as unknown as IProfileService,
    );
  });

  describe('sendMessage', () => {
    it('persists and broadcasts on the happy path', async () => {
      const res = await service.sendMessage(ACTOR, ROOM, sendDto());
      expect(chatRepo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: ROOM, senderId: ACTOR.id, content: 'hello world' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_message_sent' }),
      );
      expect(queue.enqueue).toHaveBeenCalledWith(
        'analytics-processing',
        'chat.message',
        expect.anything(),
      );
      expect(res.id).toBe('msg-1');
    });

    /**
     * The wire payload used to carry only `senderId`, so the client resolved a
     * display name off the room's live roster — which drops a sender the
     * moment they leave the room, showing a generic placeholder for their
     * still-visible messages. Resolving it here, from the user's durable
     * profile rather than room presence, survives that.
     */
    it('resolves the sender display name from the profile service', async () => {
      profiles.resolvePublicIdentities.mockResolvedValue(
        new Map([[ACTOR.id, { displayName: 'Real Username', avatarUrl: null }]]),
      );

      await service.sendMessage(ACTOR, ROOM, sendDto());

      expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith([ACTOR.id]);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ senderName: 'Real Username' }),
        }),
      );
    });

    it('rejects when the user is not a member', async () => {
      rooms.getMember.mockResolvedValue({ isActive: false });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('rejects when chat is disabled', async () => {
      rooms.getSettings.mockResolvedValue({ allowChat: false, chatSlowModeSeconds: 0 });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('rejects a muted member with MEMBER_MUTED', async () => {
      moderation.isMuted.mockResolvedValue(true);
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toMatchObject({
        errorCode: 'MEMBER_MUTED',
      });
    });

    it('rejects an over-length message', async () => {
      await expect(
        service.sendMessage(ACTOR, ROOM, sendDto({ content: 'a'.repeat(1001) })),
      ).rejects.toMatchObject({ errorCode: 'MESSAGE_TOO_LONG' });
    });

    it('enforces the rate limit', async () => {
      chatRepo.hitRateLimit.mockResolvedValue(true);
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toMatchObject({
        errorCode: 'CHAT_RATE_LIMITED',
      });
    });

    it('suppresses duplicates', async () => {
      chatRepo.isDuplicate.mockResolvedValue(true);
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toMatchObject({
        errorCode: 'DUPLICATE_MESSAGE',
      });
    });

    it('masks a MILD blocked word and still persists', async () => {
      blockedWords.scan.mockReturnValue({
        matched: true,
        severity: BlockedWordSeverity.MILD,
        action: BlockedWordAction.MASK,
        matches: ['damn'],
        maskedText: 'oh ****',
      });
      await service.sendMessage(ACTOR, ROOM, sendDto({ content: 'oh damn' }));
      expect(chatRepo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'oh ****' }),
      );
      expect(modRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CHAT_WORD_MASKED' }),
      );
    });

    it('rejects an OFFENSIVE blocked word without persisting', async () => {
      blockedWords.scan.mockReturnValue({
        matched: true,
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
        matches: ['bitch'],
        maskedText: '****',
      });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toMatchObject({
        errorCode: 'BLOCKED_WORD',
      });
      expect(chatRepo.createMessage).not.toHaveBeenCalled();
      expect(modRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CHAT_WORD_REJECTED' }),
      );
    });

    it('escalates a CRITICAL blocked word and auto-creates a report', async () => {
      blockedWords.scan.mockReturnValue({
        matched: true,
        severity: BlockedWordSeverity.CRITICAL,
        action: BlockedWordAction.ESCALATE,
        matches: ['kill yourself'],
        maskedText: '****',
      });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toMatchObject({
        errorCode: 'BLOCKED_WORD',
      });
      expect(chatRepo.createMessage).not.toHaveBeenCalled();
      expect(modRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CHAT_WORD_ESCALATED' }),
      );
      expect(modRepo.createReport).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.member_reported' }),
      );
    });

    it('auto-mutes once the violation threshold is crossed', async () => {
      chatRepo.incrViolation.mockResolvedValue(3); // == autoMuteThreshold
      blockedWords.scan.mockReturnValue({
        matched: true,
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
        matches: ['bitch'],
        maskedText: '****',
      });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(moderation.autoMute).toHaveBeenCalledWith(ROOM, ACTOR.id, expect.any(String), 15);
    });

    it('auto-kicks once the higher threshold is crossed', async () => {
      chatRepo.incrViolation.mockResolvedValue(6); // == autoKickThreshold
      blockedWords.scan.mockReturnValue({
        matched: true,
        severity: BlockedWordSeverity.OFFENSIVE,
        action: BlockedWordAction.REJECT,
        matches: ['bitch'],
        maskedText: '****',
      });
      await expect(service.sendMessage(ACTOR, ROOM, sendDto())).rejects.toBeInstanceOf(
        BusinessException,
      );
      expect(moderation.autoKick).toHaveBeenCalledWith(ROOM, ACTOR.id, expect.any(String));
      expect(moderation.autoMute).not.toHaveBeenCalled();
    });

    it('resolves @mentions to user ids and notifies them', async () => {
      users.findByUsername.mockResolvedValue({ id: 'user-2' });
      await service.sendMessage(ACTOR, ROOM, sendDto({ content: 'hi @friend' }));
      expect(chatRepo.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({ mentions: ['user-2'] }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_mention' }),
      );
    });
  });

  describe('react', () => {
    it('rejects an unsupported emoji', async () => {
      await expect(service.react(ACTOR, ROOM, { emoji: '🦄' })).rejects.toBeInstanceOf(
        BusinessException,
      );
    });

    it('broadcasts a supported emoji burst', async () => {
      await service.react(ACTOR, ROOM, { emoji: '❤️' });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_reaction' }),
      );
    });
  });

  describe('pin', () => {
    it('requires the PIN_MESSAGES permission', async () => {
      permissions.assertPermission.mockRejectedValue(new Error('forbidden'));
      await expect(service.pin(ACTOR, ROOM, 'msg-1')).rejects.toBeDefined();
    });

    it('rejects pinning an already-pinned message', async () => {
      chatRepo.getMessage.mockResolvedValue(message());
      chatRepo.getActivePin.mockResolvedValue({ id: 'pin-1' });
      await expect(service.pin(ACTOR, ROOM, 'msg-1')).rejects.toMatchObject({
        errorCode: 'ALREADY_PINNED',
      });
    });

    it('pins a valid message and broadcasts', async () => {
      chatRepo.getMessage.mockResolvedValue(message());
      await service.pin(ACTOR, ROOM, 'msg-1');
      expect(chatRepo.pin).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_message_pinned' }),
      );
    });
  });

  describe('deleteMessage', () => {
    it('lets a user delete their own message without a moderator check', async () => {
      chatRepo.getMessage.mockResolvedValue(message({ senderId: ACTOR.id }));
      await service.deleteMessage(ACTOR, ROOM, 'msg-1');
      expect(permissions.assertCanModerate).not.toHaveBeenCalled();
      expect(chatRepo.softDeleteMessage).toHaveBeenCalledWith('msg-1', ACTOR.id);
      expect(modRepo.appendAction).not.toHaveBeenCalled();
    });

    it('requires moderator authority to delete another user message and audits it', async () => {
      chatRepo.getMessage.mockResolvedValue(message({ senderId: 'other' }));
      await service.deleteMessage(ACTOR, ROOM, 'msg-1');
      expect(permissions.assertCanModerate).toHaveBeenCalled();
      expect(modRepo.appendAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CHAT_MESSAGE_DELETED' }),
      );
    });
  });

  describe('report', () => {
    it('creates a chat report and notifies moderators', async () => {
      chatRepo.getMessage.mockResolvedValue(message({ senderId: 'other' }));
      await service.report(ACTOR, ROOM, 'msg-1', { reason: 'HARASSMENT' } as never);
      expect(chatRepo.createReport).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_reported' }),
      );
    });

    it('rejects reporting your own message', async () => {
      chatRepo.getMessage.mockResolvedValue(message({ senderId: ACTOR.id }));
      await expect(
        service.report(ACTOR, ROOM, 'msg-1', { reason: 'SPAM' } as never),
      ).rejects.toMatchObject({ errorCode: 'CANNOT_MODERATE_SELF' });
    });

    it('rejects a duplicate open report', async () => {
      chatRepo.getMessage.mockResolvedValue(message({ senderId: 'other' }));
      chatRepo.findOpenReport.mockResolvedValue({ id: 'existing' });
      await expect(
        service.report(ACTOR, ROOM, 'msg-1', { reason: 'SPAM' } as never),
      ).rejects.toMatchObject({ errorCode: 'DUPLICATE_REPORT' });
    });
  });

  describe('announce', () => {
    it('creates an announcement message, unpins active pins, and pins the new announcement', async () => {
      const msg = message({ type: 'ANNOUNCEMENT' });
      chatRepo.createMessage.mockResolvedValue(msg);
      chatRepo.countActivePins.mockResolvedValue(5);
      chatRepo.listActivePins.mockResolvedValue([{ id: 'pin-1', messageId: 'old-msg' }]);

      await service.announce(ACTOR, ROOM, { content: 'hello announcement' });

      expect(chatRepo.createMessage).toHaveBeenCalled();
      expect(chatRepo.unpin).toHaveBeenCalledWith('pin-1', ACTOR.id);
      expect(chatRepo.pin).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.id }));
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_announcement' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_message_pinned' }),
      );
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'audio_room.chat_message_unpinned' }),
      );
    });
  });

  describe('history', () => {
    it('scopes listMessages to active session startedAt when room is live', async () => {
      const sessionStart = new Date('2026-08-28T10:00:00Z');
      liveSessions.getOpenSession.mockResolvedValue({ id: 's-1', startedAt: sessionStart });

      await service.history(ACTOR, ROOM, { page: 1, limit: 20, skip: 0 });

      expect(chatRepo.listMessages).toHaveBeenCalledWith(
        ROOM,
        expect.objectContaining({
          since: sessionStart,
          take: 20,
          skip: 0,
        }),
      );
    });

    it('returns empty paginated result when room is OFFLINE and no open session', async () => {
      liveSessions.getOpenSession.mockResolvedValue(null);
      rooms.findRoomRow.mockResolvedValue({ id: ROOM, status: 'OFFLINE' });

      const res = await service.history(ACTOR, ROOM, { page: 1, limit: 20, skip: 0 });

      expect(res.items).toEqual([]);
      expect(res.total).toBe(0);
      expect(chatRepo.listMessages).not.toHaveBeenCalled();
    });

    it('enriches each row with a resolved senderName without dropping other row fields', async () => {
      const row = message({ id: 'msg-2', senderId: 'someone-who-left', isDeleted: true });
      chatRepo.listMessages.mockResolvedValue([[row], 1]);
      profiles.resolvePublicIdentities.mockResolvedValue(
        new Map([['someone-who-left', { displayName: 'Departed User', avatarUrl: null }]]),
      );

      const res = await service.history(ACTOR, ROOM, { page: 1, limit: 20, skip: 0 });

      expect(profiles.resolvePublicIdentities).toHaveBeenCalledWith(['someone-who-left']);
      expect(res.items[0]).toMatchObject({
        id: 'msg-2',
        isDeleted: true,
        senderName: 'Departed User',
      });
    });
  });
});
