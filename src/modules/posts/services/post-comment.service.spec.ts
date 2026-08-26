import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostCommentService } from './post-comment.service';

describe('PostCommentService', () => {
  function build() {
    const prisma = {
      post: { findFirst: jest.fn() },
      postComment: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const bus = { publish: jest.fn() };
    const profile = { getCards: jest.fn() };
    const permissions = {
      resolveUserPermissions: jest.fn(),
      hasPermission: jest.fn((perms: Set<string>, required: string) => perms.has(required) || perms.has('*')),
    };
    const service = new PostCommentService(prisma as any, bus as any, profile as any, permissions as any);
    return { service, prisma, bus, profile, permissions };
  }

  describe('addComment', () => {
    it('throws NotFoundException for a missing post', async () => {
      const { service, prisma } = build();
      prisma.post.findFirst.mockResolvedValue(null);
      await expect(service.addComment('p1', 'u1', 'hi')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creates the comment and publishes PostCommentedEvent', async () => {
      const { service, prisma, bus, profile } = build();
      prisma.post.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.postComment.create.mockResolvedValue({ id: 'c1', postId: 'p1', authorId: 'u1' });
      profile.getCards.mockResolvedValue([{ id: 'u1', username: 'bob', fullName: 'Bob', avatarUrl: null }]);

      const comment = await service.addComment('p1', 'u1', 'hi');

      expect(comment.id).toBe('c1');
      expect(comment.author.username).toBe('bob');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', authorId: 'u1', commentId: 'c1' } }),
      );
    });
  });

  describe('listComments', () => {
    it("denormalizes each comment's author card", async () => {
      const { service, prisma, profile } = build();
      prisma.postComment.findMany.mockResolvedValue([
        { id: 'c1', postId: 'p1', authorId: 'u1', body: 'hi', createdAt: new Date() },
      ]);
      prisma.postComment.count.mockResolvedValue(1);
      profile.getCards.mockResolvedValue([
        { id: 'u1', username: 'alice', fullName: 'Alice', avatarUrl: null },
      ]);

      const page = await service.listComments('p1', 1, 20);

      expect(page.items[0].author.username).toBe('alice');
    });
  });

  describe('deleteComment', () => {
    it('rejects a non-author without post.moderate', async () => {
      const { service, prisma, permissions } = build();
      prisma.postComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set());

      await expect(service.deleteComment('c1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets the author delete their own comment', async () => {
      const { service, prisma, permissions } = build();
      prisma.postComment.findUnique.mockResolvedValue({ id: 'c1', authorId: 'u1', deletedAt: null });

      await service.deleteComment('c1', 'u1');

      expect(permissions.resolveUserPermissions).not.toHaveBeenCalled();
      expect(prisma.postComment.update).toHaveBeenCalled();
    });
  });
});
