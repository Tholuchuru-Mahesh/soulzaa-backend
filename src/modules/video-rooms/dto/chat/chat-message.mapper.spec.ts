import { deriveChatMessageStatus, toChatMessagePayload } from './chat-message.mapper';
import { ChatMessageStatus } from './chat-message.view';

/** A plain, never-touched message row. */
const BASE = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: 'TEXT',
  content: 'hello',
  mentions: ['u2'],
  mentionScope: null,
  replyToId: null,
  metadata: null,
  createdAt: new Date('2026-07-21T10:00:00.000Z'),
  editedAt: null,
  deletedAt: null,
  recalledAt: null,
};

const row = (over: Record<string, unknown> = {}) => ({ ...BASE, ...over }) as never;

describe('deriveChatMessageStatus', () => {
  it('returns SENT for an untouched row', () => {
    expect(deriveChatMessageStatus(row())).toBe(ChatMessageStatus.SENT);
  });

  it('returns EDITED when editedAt is set', () => {
    expect(deriveChatMessageStatus(row({ editedAt: new Date() }))).toBe(ChatMessageStatus.EDITED);
  });

  it('returns DELETED when deletedAt is set', () => {
    expect(deriveChatMessageStatus(row({ deletedAt: new Date() }))).toBe(ChatMessageStatus.DELETED);
  });

  it('returns RECALLED when recalledAt is set', () => {
    expect(deriveChatMessageStatus(row({ recalledAt: new Date() }))).toBe(
      ChatMessageStatus.RECALLED,
    );
  });

  // Precedence is the whole reason the checks are ordered. A recall soft-deletes
  // the row too, so both columns are set and RECALLED must win.
  it('prefers RECALLED over DELETED when both are set', () => {
    expect(deriveChatMessageStatus(row({ recalledAt: new Date(), deletedAt: new Date() }))).toBe(
      ChatMessageStatus.RECALLED,
    );
  });

  it('prefers DELETED over EDITED when both are set', () => {
    expect(deriveChatMessageStatus(row({ deletedAt: new Date(), editedAt: new Date() }))).toBe(
      ChatMessageStatus.DELETED,
    );
  });
});

describe('toChatMessagePayload', () => {
  it('projects the row onto the wire shape, including a derived status', () => {
    expect(toChatMessagePayload(row())).toEqual({
      roomId: 'r1',
      messageId: 'm1',
      senderId: 'u1',
      type: 'TEXT',
      content: 'hello',
      status: ChatMessageStatus.SENT,
      mentions: ['u2'],
      mentionScope: null,
      replyToId: null,
      createdAt: '2026-07-21T10:00:00.000Z',
    });
  });

  it('carries the derived status through on an edited row', () => {
    expect(toChatMessagePayload(row({ editedAt: new Date() })).status).toBe(
      ChatMessageStatus.EDITED,
    );
  });

  it('projects announcementId and systemEvent out of metadata when present', () => {
    const payload = toChatMessagePayload(
      row({ metadata: { announcementId: 'a1', systemEvent: 'user_joined' } }),
    );
    expect(payload.announcementId).toBe('a1');
    expect(payload.systemEvent).toBe('user_joined');
  });

  it('omits announcementId and systemEvent when metadata is absent', () => {
    const payload = toChatMessagePayload(row());
    expect(payload).not.toHaveProperty('announcementId');
    expect(payload).not.toHaveProperty('systemEvent');
  });
});
