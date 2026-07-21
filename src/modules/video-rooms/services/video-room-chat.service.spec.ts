import { VideoRoomMessageType } from '@prisma/client';
import { ERROR_CODES } from 'src/common/exceptions/error-codes';
import type { RoomActor } from '../interfaces/room-actor.interface';
import { VideoRoomChatService } from './video-room-chat.service';

const ACTOR: RoomActor = { id: 'u1', roles: [] };
const ROOM = { id: 'r1', ownerId: 'owner-1' };
const SETTINGS = { chatRateLimitPerMinute: 20, slowModeSeconds: 0 };
const MESSAGE = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: VideoRoomMessageType.TEXT,
  content: 'hello',
  mentions: [],
  mentionScope: null,
  replyToId: null,
  createdAt: new Date('2026-07-21T00:00:00Z'),
};

describe('VideoRoomChatService.send', () => {
  let policy: { assertCanSend: jest.Mock };
  let limiter: { assertMaySend: jest.Mock; applySlowMode: jest.Mock };
  let words: { scan: jest.Mock };
  let mentions: { resolve: jest.Mock };
  let repo: { createMessage: jest.Mock; findMessage: jest.Mock };
  let cache: { pushRecent: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomChatService;

  beforeEach(() => {
    policy = {
      assertCanSend: jest
        .fn()
        .mockResolvedValue({ room: ROOM, settings: SETTINGS, role: 'VIEWER' }),
    };
    limiter = { assertMaySend: jest.fn(), applySlowMode: jest.fn() };
    words = { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) };
    mentions = { resolve: jest.fn().mockResolvedValue({ userIds: [], scope: null }) };
    repo = {
      createMessage: jest.fn().mockResolvedValue(MESSAGE),
      findMessage: jest.fn().mockResolvedValue(null),
    };
    cache = { pushRecent: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomChatService(
      policy as never,
      limiter as never,
      words as never,
      mentions as never,
      repo as never,
      cache as never,
      bus as never,
    );
  });

  it('runs the gates in order: policy, then rate limit, then persist', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    const policyOrder = policy.assertCanSend.mock.invocationCallOrder[0];
    const limiterOrder = limiter.assertMaySend.mock.invocationCallOrder[0];
    const createOrder = repo.createMessage.mock.invocationCallOrder[0];
    expect(policyOrder).toBeLessThan(limiterOrder);
    expect(limiterOrder).toBeLessThan(createOrder);
  });

  it('persists before broadcasting — nothing after the insert can reject', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    expect(repo.createMessage.mock.invocationCallOrder[0]).toBeLessThan(
      bus.publish.mock.invocationCallOrder[0],
    );
    expect(cache.pushRecent).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('trims content before length checks and storage', async () => {
    await service.send(ACTOR, 'r1', { content: '  hello  ' });

    expect(policy.assertCanSend).toHaveBeenCalledWith(
      ACTOR,
      'r1',
      expect.objectContaining({ contentLength: 5 }),
    );
    expect(repo.createMessage).toHaveBeenCalledWith(expect.objectContaining({ content: 'hello' }));
  });

  it('stores the masked text when a MILD word matched', async () => {
    words.scan.mockReturnValue({
      matched: true,
      action: 'MASK',
      severity: 'MILD',
      matches: ['darn'],
      maskedText: '***',
    });

    await service.send(ACTOR, 'r1', { content: 'darn' });

    expect(repo.createMessage).toHaveBeenCalledWith(expect.objectContaining({ content: '***' }));
  });

  it('rejects on REJECT and never persists', async () => {
    words.scan.mockReturnValue({
      matched: true,
      action: 'REJECT',
      severity: 'OFFENSIVE',
      matches: ['x'],
      maskedText: '***',
    });

    await expect(service.send(ACTOR, 'r1', { content: 'x' })).rejects.toMatchObject({
      errorCode: ERROR_CODES.BLOCKED_WORD,
    });
    expect(repo.createMessage).not.toHaveBeenCalled();
  });

  it('rejects on ESCALATE without taking a moderation action', async () => {
    // Detection yes, enforcement no — Moderation Actions is out of VR-9 scope.
    words.scan.mockReturnValue({
      matched: true,
      action: 'ESCALATE',
      severity: 'CRITICAL',
      matches: ['x'],
      maskedText: '***',
    });

    await expect(service.send(ACTOR, 'r1', { content: 'x' })).rejects.toMatchObject({
      errorCode: ERROR_CODES.BLOCKED_WORD,
    });
  });

  it('publishes a mention event only when mentions resolved', async () => {
    mentions.resolve.mockResolvedValue({ userIds: ['u2'], scope: null });
    repo.createMessage.mockResolvedValue({ ...MESSAGE, mentions: ['u2'] });

    await service.send(ACTOR, 'r1', { content: 'hi @bob' });

    const names = bus.publish.mock.calls.map((c) => c[0].name);
    expect(names).toContain('video_room.chat_message_sent');
    expect(names).toContain('video_room.chat_mentioned');
  });

  it('does not publish a mention event when there are none', async () => {
    await service.send(ACTOR, 'r1', { content: 'hello' });

    const names = bus.publish.mock.calls.map((c) => c[0].name);
    expect(names).not.toContain('video_room.chat_mentioned');
  });

  it('rejects a reply whose target is missing or from another room', async () => {
    repo.findMessage.mockResolvedValue({ id: 'm9', roomId: 'other', deletedAt: null });

    await expect(
      service.send(ACTOR, 'r1', { content: 'hi', replyToId: 'm9' }),
    ).rejects.toMatchObject({ errorCode: ERROR_CODES.VIDEO_ROOM_REPLY_TARGET_INVALID });
  });

  it('allows replying to a deleted parent (tombstone rendering)', async () => {
    repo.findMessage.mockResolvedValue({ id: 'm9', roomId: 'r1', deletedAt: new Date() });

    await expect(
      service.send(ACTOR, 'r1', { content: 'hi', replyToId: 'm9' }),
    ).resolves.toBeDefined();
  });

  it('arms slow mode after a successful send', async () => {
    policy.assertCanSend.mockResolvedValue({
      room: ROOM,
      settings: { ...SETTINGS, slowModeSeconds: 10 },
      role: 'VIEWER',
    });

    await service.send(ACTOR, 'r1', { content: 'hello' });

    expect(limiter.applySlowMode).toHaveBeenCalledWith('r1', 'u1', 10);
  });
});

describe('VideoRoomChatService edit/delete/recall', () => {
  let policy: {
    assertCanSend: jest.Mock;
    assertCanEdit: jest.Mock;
    assertCanDelete: jest.Mock;
    assertCanRecall: jest.Mock;
  };
  let repo: Record<string, jest.Mock>;
  let cache: { pushRecent: jest.Mock; invalidateRecent: jest.Mock };
  let bus: { publish: jest.Mock };
  let service: VideoRoomChatService;

  const stored = {
    id: 'm1',
    roomId: 'r1',
    senderId: 'u1',
    type: VideoRoomMessageType.TEXT,
    content: 'hello',
    mentions: [],
    mentionScope: null,
    replyToId: null,
    metadata: null,
    deletedAt: null,
    recalledAt: null,
    createdAt: new Date('2026-07-21T00:00:00Z'),
  };

  beforeEach(() => {
    policy = {
      assertCanSend: jest.fn(),
      assertCanEdit: jest.fn(),
      assertCanDelete: jest.fn().mockResolvedValue({ byModerator: false }),
      assertCanRecall: jest.fn(),
    };
    repo = {
      findMessage: jest.fn().mockResolvedValue(stored),
      editMessage: jest
        .fn()
        .mockResolvedValue({ ...stored, content: 'edited', editedAt: new Date() }),
      softDeleteMessage: jest.fn(),
      recallMessage: jest.fn(),
      findActivePin: jest.fn().mockResolvedValue(null),
      deactivatePin: jest.fn(),
    };
    cache = { pushRecent: jest.fn(), invalidateRecent: jest.fn() };
    bus = { publish: jest.fn() };
    service = new VideoRoomChatService(
      policy as never,
      { assertMaySend: jest.fn(), applySlowMode: jest.fn() } as never,
      { scan: jest.fn().mockReturnValue({ matched: false, matches: [], maskedText: '' }) } as never,
      { resolve: jest.fn() } as never,
      repo as never,
      cache as never,
      bus as never,
    );
  });

  it('404s when the message is not in this room', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, roomId: 'other' });
    await expect(service.edit({ id: 'u1', roles: [] }, 'r1', 'm1', 'x')).rejects.toMatchObject({
      errorCode: ERROR_CODES.MESSAGE_NOT_FOUND,
    });
  });

  it('edits and invalidates the cached buffer', async () => {
    await service.edit({ id: 'u1', roles: [] }, 'r1', 'm1', ' edited ');

    expect(policy.assertCanEdit).toHaveBeenCalled();
    expect(repo.editMessage).toHaveBeenCalledWith('m1', 'edited');
    // The buffer holds a stale copy of this message — drop it rather than
    // trying to surgically rewrite an entry inside a Redis list.
    expect(cache.invalidateRecent).toHaveBeenCalledWith('r1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_edited');
  });

  it('soft-deletes and reports moderator provenance on the event', async () => {
    policy.assertCanDelete.mockResolvedValue({ byModerator: true });

    await service.remove({ id: 'mod', roles: [] }, 'r1', 'm1');

    expect(repo.softDeleteMessage).toHaveBeenCalledWith('m1', 'mod');
    expect(bus.publish.mock.calls[0][0].payload.byModerator).toBe(true);
  });

  it('unpins a pinned message when it is deleted', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });

    await service.remove({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
  });

  it('delete is idempotent — a second call is a no-op', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, deletedAt: new Date() });

    await service.remove({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.softDeleteMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('recalls and unpins', async () => {
    repo.findActivePin.mockResolvedValue({ id: 'p1' });

    await service.recall({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(policy.assertCanRecall).toHaveBeenCalled();
    expect(repo.recallMessage).toHaveBeenCalledWith('m1');
    expect(repo.deactivatePin).toHaveBeenCalledWith('p1', 'u1');
    expect(cache.invalidateRecent).toHaveBeenCalledWith('r1');
    expect(bus.publish.mock.calls[0][0].name).toBe('video_room.chat_message_recalled');
  });

  it('recall is idempotent', async () => {
    repo.findMessage.mockResolvedValue({ ...stored, recalledAt: new Date() });

    await service.recall({ id: 'u1', roles: [] }, 'r1', 'm1');

    expect(repo.recallMessage).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
