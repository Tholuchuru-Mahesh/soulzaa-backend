import { VideoRoomSnapshotReason } from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomEventsRepository } from './video-room-events.repository';

describe('VideoRoomEventsRepository', () => {
  let prisma: any;
  let repo: VideoRoomEventsRepository;

  beforeEach(() => {
    prisma = {
      videoRoomEvent: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
      },
      videoRoomSnapshot: {
        create: jest.fn().mockResolvedValue({ id: 'snap1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
      videoRoomAnnouncement: {
        create: jest.fn().mockResolvedValue({ id: 'ann1' }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'ann1' }),
      },
    };
    repo = new VideoRoomEventsRepository(prisma as unknown as PrismaService);
  });

  it('appendEvent writes a free-form event with correlation id', async () => {
    await repo.appendEvent({
      roomId: 'r1',
      actorId: 'a1',
      eventType: 'seat.taken',
      correlationId: 'c1',
    });
    expect(prisma.videoRoomEvent.create).toHaveBeenCalledWith({
      data: {
        roomId: 'r1',
        actorId: 'a1',
        eventType: 'seat.taken',
        payload: undefined,
        referenceId: null,
        correlationId: 'c1',
      },
    });
  });

  it('saveSnapshot defaults the reason to PERIODIC', async () => {
    await repo.saveSnapshot({ roomId: 'r1', version: 7, state: { a: 1 } });
    const data = prisma.videoRoomSnapshot.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      roomId: 'r1',
      version: 7,
      reason: VideoRoomSnapshotReason.PERIODIC,
    });
  });

  it('findLatestSnapshot returns the newest snapshot for a room', async () => {
    await repo.findLatestSnapshot('r1');
    expect(prisma.videoRoomSnapshot.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'r1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('listAnnouncements excludes soft-deleted and orders pinned first', async () => {
    await repo.listAnnouncements('r1');
    expect(prisma.videoRoomAnnouncement.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', deletedAt: null },
      orderBy: [{ isPinned: 'desc' }, { createdAt: 'desc' }],
    });
  });

  it('softDeleteAnnouncement stamps deletedAt via the audit helper', async () => {
    await repo.softDeleteAnnouncement('ann1', 'author');
    const data = prisma.videoRoomAnnouncement.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.updatedBy).toBe('author');
  });
});
