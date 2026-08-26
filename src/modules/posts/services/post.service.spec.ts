import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PostStatus } from '@prisma/client';
import { PostService } from './post.service';

describe('PostService', () => {
  function build() {
    const prisma = {
      post: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    };
    const bus = { publish: jest.fn() };
    const permissions = {
      resolveUserPermissions: jest.fn(),
      hasPermission: jest.fn(
        (perms: Set<string>, required: string) => perms.has(required) || perms.has('*'),
      ),
    };
    const service = new PostService(prisma as any, bus as any, permissions as any);
    return { service, prisma, bus, permissions };
  }

  describe('createPost', () => {
    it('rejects a post with no description and no photos', async () => {
      const { service } = build();
      await expect(
        service.createPost({ authorId: 'u1', description: undefined, mediaKeys: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a photo key that does not belong to the author', async () => {
      const { service } = build();
      await expect(
        service.createPost({ authorId: 'u1', mediaKeys: ['post-images/someone-else/a.jpg'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a post and publishes PostCreatedEvent', async () => {
      const { service, prisma, bus } = build();
      prisma.post.create.mockResolvedValue({ id: 'p1', authorId: 'u1' });

      const post = await service.createPost({
        authorId: 'u1',
        description: 'hi',
        mediaKeys: ['post-images/u1/a.jpg'],
      });

      expect(post).toEqual({ id: 'p1', authorId: 'u1' });
      expect(prisma.post.create).toHaveBeenCalledWith({
        data: {
          authorId: 'u1',
          description: 'hi',
          media: { create: [{ key: 'post-images/u1/a.jpg', order: 0 }] },
        },
      });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', authorId: 'u1' } }),
      );
    });
  });

  describe('deletePost', () => {
    it('throws NotFoundException for a missing post', async () => {
      const { service, prisma } = build();
      prisma.post.findUnique.mockResolvedValue(null);
      await expect(service.deletePost('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets the author delete their own post without a permission check', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });

      await service.deletePost('p1', 'u1');

      expect(permissions.resolveUserPermissions).not.toHaveBeenCalled();
      expect(prisma.post.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: expect.objectContaining({ status: PostStatus.REMOVED }),
      });
    });

    it('rejects a non-author without post.moderate', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set());

      await expect(service.deletePost('p1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('lets a moderator delete someone else’s post', async () => {
      const { service, prisma, permissions } = build();
      prisma.post.findUnique.mockResolvedValue({ id: 'p1', authorId: 'u1', deletedAt: null });
      permissions.resolveUserPermissions.mockResolvedValue(new Set(['post.moderate']));

      await service.deletePost('p1', 'mod1');

      expect(prisma.post.update).toHaveBeenCalled();
    });
  });
});
