import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomReferenceRepository } from './video-room-reference.repository';

describe('VideoRoomReferenceRepository', () => {
  let prisma: any;
  let repo: VideoRoomReferenceRepository;

  beforeEach(() => {
    prisma = {
      videoRoomTheme: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 't1' }),
        count: jest.fn().mockResolvedValue(0),
      },
      videoRoomBackground: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'b1' }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    repo = new VideoRoomReferenceRepository(prisma as unknown as PrismaService);
  });

  it('listActiveThemes returns only active themes in display order', async () => {
    await repo.listActiveThemes();
    expect(prisma.videoRoomTheme.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('upsertTheme is idempotent by slug and never clobbers isActive', async () => {
    await repo.upsertTheme({ slug: 'neon', name: 'Neon', isPremium: true, sortOrder: 40 });
    const arg = prisma.videoRoomTheme.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ slug: 'neon' });
    expect(arg.create).toMatchObject({ slug: 'neon', isPremium: true });
    expect(arg.update).not.toHaveProperty('isActive');
  });

  it('upsertBackground keys on slug', async () => {
    await repo.upsertBackground({ slug: 'galaxy', name: 'Galaxy', isPremium: true, sortOrder: 40 });
    expect(prisma.videoRoomBackground.upsert.mock.calls[0][0].where).toEqual({ slug: 'galaxy' });
  });
});
