import { VideoRoomMemberRole } from '@prisma/client';
import { VideoRoomChatQueryService } from './video-room-chat-query.service';

const ACTOR = { id: 'u1', roles: [] };
const ROW = {
  id: 'm1',
  roomId: 'r1',
  senderId: 'u1',
  type: 'TEXT',
  content: 'hi',
  mentions: [],
  mentionScope: null,
  replyToId: null,
  metadata: null,
  createdAt: new Date('2026-07-21T00:00:00Z'),
};

describe('VideoRoomChatQueryService', () => {
  let repo: Record<string, jest.Mock>;
  let cache: { readRecent: jest.Mock };
  let policy: { assertActiveMember: jest.Mock };
  let rooms: { findById: jest.Mock };
  let permissions: { resolveEffectiveRole: jest.Mock };
  let service: VideoRoomChatQueryService;

  beforeEach(() => {
    repo = {
      listMessages: jest.fn().mockResolvedValue([[ROW], 1]),
      searchMessages: jest.fn().mockResolvedValue([[ROW], 1]),
      findCursor: jest.fn().mockResolvedValue(null),
      countUnread: jest.fn().mockResolvedValue(7),
    };
    cache = { readRecent: jest.fn().mockResolvedValue([]) };
    policy = { assertActiveMember: jest.fn() };
    rooms = { findById: jest.fn().mockResolvedValue({ id: 'r1', ownerId: 'o1' }) };
    permissions = {
      resolveEffectiveRole: jest.fn().mockResolvedValue(VideoRoomMemberRole.VIEWER),
    };
    service = new VideoRoomChatQueryService(
      repo as never,
      cache as never,
      policy as never,
      rooms as never,
      permissions as never,
    );
  });

  it('serves page 1 from the Redis ring buffer without touching Postgres', async () => {
    cache.readRecent.mockResolvedValue([{ messageId: 'm1', roomId: 'r1' }]);

    const result = await service.history(ACTOR as never, 'r1', {
      page: 1,
      limit: 20,
      skip: 0,
    });

    expect(cache.readRecent).toHaveBeenCalledWith('r1', 20);
    expect(repo.listMessages).not.toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
  });

  it('falls through to Postgres on a cold buffer', async () => {
    cache.readRecent.mockResolvedValue([]);

    await service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0 });

    expect(repo.listMessages).toHaveBeenCalled();
  });

  it('never uses the buffer for deep pages or keyset reads', async () => {
    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });
    expect(cache.readRecent).not.toHaveBeenCalled();

    cache.readRecent.mockClear();
    await service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0, before: 'm9' });
    expect(cache.readRecent).not.toHaveBeenCalled();
  });

  it('shows soft-deleted rows to moderators only', async () => {
    permissions.resolveEffectiveRole.mockResolvedValue(VideoRoomMemberRole.MODERATOR);

    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });

    expect(repo.listMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ includeDeleted: true }),
    );
  });

  it('hides soft-deleted rows from ordinary members', async () => {
    await service.history(ACTOR as never, 'r1', { page: 2, limit: 20, skip: 20 });

    expect(repo.listMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ includeDeleted: false }),
    );
  });

  it('requires active membership before reading anything', async () => {
    policy.assertActiveMember.mockRejectedValue(new Error('not a member'));
    await expect(
      service.history(ACTOR as never, 'r1', { page: 1, limit: 20, skip: 0 }),
    ).rejects.toThrow('not a member');
  });

  it('passes every search filter through', async () => {
    const from = new Date('2026-07-01');
    await service.search(ACTOR as never, 'r1', {
      page: 1,
      limit: 20,
      skip: 0,
      q: 'hello',
      senderId: 'u2',
      from,
    });

    expect(repo.searchMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ term: 'hello', senderId: 'u2', from }),
    );
  });

  it('passes pinnedOnly and announcementsOnly through to the repository', async () => {
    await service.search(ACTOR as never, 'r1', {
      page: 1,
      limit: 20,
      skip: 0,
      pinnedOnly: true,
      announcementsOnly: true,
    });

    expect(repo.searchMessages).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ pinnedOnly: true, announcementsOnly: true }),
    );
  });

  it('counts everything unread when the user has no cursor yet', async () => {
    const result = await service.unreadCount(ACTOR as never, 'r1');
    expect(repo.countUnread).toHaveBeenCalledWith('r1', null);
    expect(result).toEqual({ unread: 7 });
  });

  it('counts from the read mark once a cursor exists', async () => {
    const at = new Date('2026-07-21T00:00:00Z');
    repo.findCursor.mockResolvedValue({ lastReadAt: at });

    await service.unreadCount(ACTOR as never, 'r1');

    expect(repo.countUnread).toHaveBeenCalledWith('r1', at);
  });
});
