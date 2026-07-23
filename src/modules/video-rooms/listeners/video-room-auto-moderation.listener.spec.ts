// src/modules/video-rooms/listeners/video-room-auto-moderation.listener.spec.ts
import { createHash } from 'node:crypto';
import { VideoRoomAutoModerationListener } from './video-room-auto-moderation.listener';
import { VIDEO_ROOM_CHAT_EVENTS } from '../events/video-room-chat.events';
import { VIDEO_ROOM_EVENTS } from '../events/video-room.events';
import { VIDEO_ROOM_MODERATION_EVENTS } from '../events/video-room-moderation.events';

function sha1(input: string): string {
  return createHash('sha1').update(input.toLowerCase()).digest('hex');
}

function makeDeps() {
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const bus = {
    subscribe: (n: string, h: (e: unknown) => unknown) => {
      handlers[n] = h;
      return () => undefined;
    },
    publish: jest.fn(),
  };
  const autoMod = { handle: jest.fn().mockResolvedValue(undefined) };
  new VideoRoomAutoModerationListener(bus as never, autoMod as never).onModuleInit();
  return { handlers, autoMod };
}

describe('VideoRoomAutoModerationListener', () => {
  it('maps a MESSAGE_SENT event to an unflagged message signal', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT]({
      payload: {
        roomId: 'r1',
        messageId: 'm1',
        senderId: 'u1',
        type: 'TEXT',
        content: 'Hello World',
        status: 'SENT',
        mentions: [],
        mentionScope: null,
        replyToId: null,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'message',
      roomId: 'r1',
      userId: 'u1',
      contentHash: sha1('Hello World'),
      spamFlagged: false,
    });
  });

  it('maps a SPAM_DETECTED event to a flagged message signal with NO contentHash (the payload carries no real content, so no proxy hash is fed to the duplicate detector)', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind: 'blocked_word' },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'message',
      roomId: 'r1',
      userId: 'u1',
      spamFlagged: true,
    });
    const signal = d.autoMod.handle.mock.calls[0][0];
    expect(signal).not.toHaveProperty('contentHash');
  });

  it('maps two SPAM_DETECTED events of the same kind without ever hashing the kind (no false duplicate signal)', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind: 'rate' },
    });
    await d.handlers[VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED]({
      payload: { roomId: 'r1', userId: 'u1', kind: 'rate' },
    });

    for (const call of d.autoMod.handle.mock.calls) {
      expect(call[0]).not.toHaveProperty('contentHash');
    }
  });

  it('maps USER_JOINED to a join_leave signal', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_EVENTS.USER_JOINED]({
      payload: { roomId: 'r1', userId: 'u1', participantCount: 3 },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'join_leave',
      roomId: 'r1',
      userId: 'u1',
    });
  });

  it('maps USER_LEFT to a join_leave signal', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_EVENTS.USER_LEFT]({
      payload: { roomId: 'r1', userId: 'u1', participantCount: 2 },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'join_leave',
      roomId: 'r1',
      userId: 'u1',
    });
  });

  it('maps SESSION_EXPIRED (grace-window reclaim) to a join_leave signal', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_EVENTS.SESSION_EXPIRED]({
      payload: { roomId: 'r1', userId: 'u1', socketId: 's1', durationSeconds: 30 },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'join_leave',
      roomId: 'r1',
      userId: 'u1',
    });
  });

  it('maps UserReportedEvent to a report signal keyed on the target user', async () => {
    const d = makeDeps();

    await d.handlers[VIDEO_ROOM_MODERATION_EVENTS.REPORTED]({
      payload: {
        roomId: 'r1',
        reportId: 'rep1',
        reporterId: 'u1',
        targetUserId: 'u2',
        reason: 'ABUSE',
        recipientIds: ['mod1'],
      },
    });

    expect(d.autoMod.handle).toHaveBeenCalledWith({
      type: 'report',
      roomId: 'r1',
      targetUserId: 'u2',
    });
  });

  it('subscribes to exactly the six source events (no detection logic, purely a bridge)', () => {
    const subscribed: string[] = [];
    const bus = {
      subscribe: (n: string) => {
        subscribed.push(n);
        return () => undefined;
      },
      publish: jest.fn(),
    };
    const autoMod = { handle: jest.fn() };
    new VideoRoomAutoModerationListener(bus as never, autoMod as never).onModuleInit();

    expect(subscribed.sort()).toEqual(
      [
        VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT,
        VIDEO_ROOM_CHAT_EVENTS.SPAM_DETECTED,
        VIDEO_ROOM_EVENTS.USER_JOINED,
        VIDEO_ROOM_EVENTS.USER_LEFT,
        VIDEO_ROOM_EVENTS.SESSION_EXPIRED,
        VIDEO_ROOM_MODERATION_EVENTS.REPORTED,
      ].sort(),
    );
  });
});
