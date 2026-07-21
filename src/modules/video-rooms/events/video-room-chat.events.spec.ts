import { ChatMessageStatus } from '../dto/chat/chat-message.view';
import {
  ChatMessageSentEvent,
  ChatModeChangedEvent,
  ChatTypingStartedEvent,
  VIDEO_ROOM_CHAT_EVENTS,
} from './video-room-chat.events';

describe('video-room chat events', () => {
  it('carries a stable dot-namespaced name and the payload', () => {
    const event = new ChatMessageSentEvent({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'u1',
      type: 'TEXT',
      content: 'hi',
      status: ChatMessageStatus.SENT,
      mentions: [],
      mentionScope: null,
      replyToId: null,
      createdAt: '2026-07-21T00:00:00.000Z',
    });

    expect(event.name).toBe(VIDEO_ROOM_CHAT_EVENTS.MESSAGE_SENT);
    expect(event.name).toBe('video_room.chat_message_sent');
    expect(event.payload.messageId).toBe('m1');
    expect(event.eventId).toEqual(expect.any(String));
  });

  it('exposes all 16 event names', () => {
    expect(Object.keys(VIDEO_ROOM_CHAT_EVENTS)).toHaveLength(16);
  });

  it('typing events carry the room and user', () => {
    const event = new ChatTypingStartedEvent({ roomId: 'r1', userId: 'u1' });
    expect(event.name).toBe('video_room.chat_typing_started');
    expect(event.payload.userId).toBe('u1');
  });

  it('carries the chat-mode-changed payload (VR-9.1a)', () => {
    const event = new ChatModeChangedEvent({
      roomId: 'r1',
      chatMode: 'PARTICIPANTS_ONLY',
      allowChat: true,
      slowModeSeconds: 5,
      actorId: 'owner-1',
    });

    expect(event.name).toBe(VIDEO_ROOM_CHAT_EVENTS.CHAT_MODE_CHANGED);
    expect(event.name).toBe('video_room.chat_mode_changed');
    expect(event.payload).toEqual({
      roomId: 'r1',
      chatMode: 'PARTICIPANTS_ONLY',
      allowChat: true,
      slowModeSeconds: 5,
      actorId: 'owner-1',
    });
  });
});
