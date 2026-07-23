import { VideoRoomReportReason, VideoRoomReportStatus } from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomReportRepository } from './video-room-report.repository';

describe('VideoRoomReportRepository', () => {
  let prisma: any;
  let repo: VideoRoomReportRepository;

  beforeEach(() => {
    prisma = {
      videoRoomReport: {
        create: jest.fn().mockResolvedValue({ id: 'rep1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'rep1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((arg: any) => Promise.all(arg)),
    };
    repo = new VideoRoomReportRepository(prisma as unknown as PrismaService);
  });

  it('create stamps audit cols from the reporter and writes the report', async () => {
    await repo.create({
      roomId: 'r1',
      reporterId: 'reporter1',
      targetUserId: 'target1',
      reason: VideoRoomReportReason.SPAM,
    });
    expect(prisma.videoRoomReport.create).toHaveBeenCalledWith({
      data: {
        roomId: 'r1',
        reporterId: 'reporter1',
        targetUserId: 'target1',
        messageId: null,
        reason: VideoRoomReportReason.SPAM,
        description: null,
        createdBy: 'reporter1',
        updatedBy: 'reporter1',
      },
    });
  });

  it('create carries an optional messageId and description through', async () => {
    await repo.create({
      roomId: 'r1',
      reporterId: 'reporter1',
      targetUserId: 'target1',
      messageId: 'msg1',
      reason: VideoRoomReportReason.HARASSMENT,
      description: 'said something rude',
    });
    const data = prisma.videoRoomReport.create.mock.calls[0][0].data;
    expect(data.messageId).toBe('msg1');
    expect(data.description).toBe('said something rude');
  });

  it('getById looks up by id', async () => {
    await repo.getById('rep1');
    expect(prisma.videoRoomReport.findUnique).toHaveBeenCalledWith({ where: { id: 'rep1' } });
  });

  it('findOpen filters to PENDING for the reporter/target pair', async () => {
    await repo.findOpen('r1', 'reporter1', 'target1');
    expect(prisma.videoRoomReport.findFirst).toHaveBeenCalledWith({
      where: {
        roomId: 'r1',
        reporterId: 'reporter1',
        targetUserId: 'target1',
        status: VideoRoomReportStatus.PENDING,
      },
    });
  });

  it('findOpen scopes to a specific messageId when provided', async () => {
    await repo.findOpen('r1', 'reporter1', 'target1', 'msg1');
    expect(prisma.videoRoomReport.findFirst).toHaveBeenCalledWith({
      where: {
        roomId: 'r1',
        reporterId: 'reporter1',
        targetUserId: 'target1',
        status: VideoRoomReportStatus.PENDING,
        messageId: 'msg1',
      },
    });
  });

  it('review records the reviewer, status and resolution', async () => {
    await repo.review('rep1', 'mod1', VideoRoomReportStatus.REVIEWED, 'warned user');
    const data = prisma.videoRoomReport.update.mock.calls[0][0].data;
    expect(prisma.videoRoomReport.update.mock.calls[0][0].where).toEqual({ id: 'rep1' });
    expect(data.status).toBe(VideoRoomReportStatus.REVIEWED);
    expect(data.reviewedBy).toBe('mod1');
    expect(data.reviewedAt).toBeInstanceOf(Date);
    expect(data.resolutionAction).toBe('warned user');
    expect(data.updatedBy).toBe('mod1');
  });

  it('review defaults resolutionAction to null when omitted', async () => {
    await repo.review('rep1', 'mod1', VideoRoomReportStatus.DISMISSED);
    const data = prisma.videoRoomReport.update.mock.calls[0][0].data;
    expect(data.resolutionAction).toBeNull();
  });

  it('list returns a $transaction([findMany, count]) tuple ordered createdAt desc', async () => {
    await repo.list('r1', { skip: 0, take: 20 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.videoRoomReport.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({ where: { roomId: 'r1' } });
  });

  it('list scopes to targetUserId when provided', async () => {
    await repo.list('r1', { skip: 0, take: 20, targetUserId: 'target1' });
    expect(prisma.videoRoomReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { roomId: 'r1', targetUserId: 'target1' } }),
    );
    expect(prisma.videoRoomReport.count).toHaveBeenCalledWith({
      where: { roomId: 'r1', targetUserId: 'target1' },
    });
  });
});
