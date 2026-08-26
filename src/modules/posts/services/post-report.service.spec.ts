import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PostReportService } from './post-report.service';

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: '6.0.0',
  });
}

describe('PostReportService', () => {
  it('creates a report row', async () => {
    const prisma = {
      post: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
      postReport: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
    };
    const service = new PostReportService(prisma as any);

    const report = await service.report('p1', 'u1', 'spam');

    expect(report).toEqual({ id: 'r1' });
    expect(prisma.postReport.create).toHaveBeenCalledWith({
      data: { postId: 'p1', reporterId: 'u1', reason: 'spam' },
    });
  });

  it('maps a duplicate report to a friendly ConflictException', async () => {
    const prisma = {
      post: { findFirst: jest.fn().mockResolvedValue({ id: 'p1' }) },
      postReport: { create: jest.fn().mockRejectedValue(uniqueViolation()) },
    };
    const service = new PostReportService(prisma as any);

    await expect(service.report('p1', 'u1', 'spam')).rejects.toBeInstanceOf(ConflictException);
  });

  it('throws NotFoundException when the post does not exist or is removed', async () => {
    const prisma = {
      post: { findFirst: jest.fn().mockResolvedValue(null) },
      postReport: { create: jest.fn() },
    };
    const service = new PostReportService(prisma as any);

    await expect(service.report('p1', 'u1', 'spam')).rejects.toBeInstanceOf(NotFoundException);
  });
});
