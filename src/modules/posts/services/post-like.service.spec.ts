import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PostLikeService } from './post-like.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

describe('PostLikeService', () => {
  function build() {
    const prisma = { post: { findFirst: jest.fn() }, postLike: { create: jest.fn(), deleteMany: jest.fn() } };
    const bus = { publish: jest.fn() };
    const service = new PostLikeService(prisma as any, bus as any);
    return { service, prisma, bus };
  }

  describe('like', () => {
    it('creates the like row and publishes PostLikedEvent', async () => {
      const { service, prisma, bus } = build();
      prisma.post.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.postLike.create.mockResolvedValue({});

      await service.like('p1', 'u1');

      expect(prisma.postLike.create).toHaveBeenCalledWith({ data: { postId: 'p1', userId: 'u1' } });
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', userId: 'u1' } }),
      );
    });

    it('is idempotent — a duplicate like does not publish again', async () => {
      const { service, prisma, bus } = build();
      prisma.post.findFirst.mockResolvedValue({ id: 'p1' });
      prisma.postLike.create.mockRejectedValue(uniqueViolation());

      await service.like('p1', 'u1');

      expect(bus.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the post does not exist or is removed', async () => {
      const { service, prisma } = build();
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(service.like('p1', 'u1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('unlike', () => {
    it('publishes PostUnlikedEvent only when a row was actually deleted', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.deleteMany.mockResolvedValue({ count: 1 });

      await service.unlike('p1', 'u1');

      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { postId: 'p1', userId: 'u1' } }),
      );
    });

    it('does nothing when there was no like to remove', async () => {
      const { service, prisma, bus } = build();
      prisma.postLike.deleteMany.mockResolvedValue({ count: 0 });

      await service.unlike('p1', 'u1');

      expect(bus.publish).not.toHaveBeenCalled();
    });
  });
});
