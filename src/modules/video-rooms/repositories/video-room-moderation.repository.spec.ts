import {
  VideoRoomModerationActionType,
  VideoRoomModerationMuteType,
  VideoRoomModerationStatus,
} from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomModerationRepository } from './video-room-moderation.repository';

describe('VideoRoomModerationRepository', () => {
  let prisma: any;
  let repo: VideoRoomModerationRepository;

  beforeEach(() => {
    prisma = {
      videoRoomMute: {
        create: jest.fn().mockResolvedValue({ id: 'm1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: 'm1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      videoRoomBlock: {
        create: jest.fn().mockResolvedValue({ id: 'b1' }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'b1' }),
      },
      videoRoomModerationAction: {
        create: jest.fn().mockResolvedValue(undefined),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    repo = new VideoRoomModerationRepository(prisma as unknown as PrismaService);
  });

  it('createMute stamps audit from the moderator', async () => {
    await repo.createMute({
      roomId: 'r1',
      userId: 'u1',
      moderatorId: 'mod',
      type: VideoRoomModerationMuteType.TEMPORARY,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const data = prisma.videoRoomMute.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      roomId: 'r1',
      moderatorId: 'mod',
      createdBy: 'mod',
      updatedBy: 'mod',
    });
  });

  it('findActiveMute filters to ACTIVE status', async () => {
    await repo.findActiveMute('r1', 'u1');
    expect(prisma.videoRoomMute.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('liftMute records who lifted it and when', async () => {
    await repo.liftMute('m1', 'mod2');
    const data = prisma.videoRoomMute.update.mock.calls[0][0].data;
    expect(data.status).toBe(VideoRoomModerationStatus.LIFTED);
    expect(data.liftedBy).toBe('mod2');
    expect(data.liftedAt).toBeInstanceOf(Date);
  });

  it('expireMutes only touches ACTIVE mutes past expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const count = await repo.expireMutes(now);
    expect(prisma.videoRoomMute.updateMany).toHaveBeenCalledWith({
      where: { status: VideoRoomModerationStatus.ACTIVE, expiresAt: { lt: now } },
      data: { status: VideoRoomModerationStatus.EXPIRED },
    });
    expect(count).toBe(3);
  });

  it('findActiveBlock is the join-time gate (ACTIVE only)', async () => {
    await repo.findActiveBlock('r1', 'u1');
    expect(prisma.videoRoomBlock.findFirst).toHaveBeenCalledWith({
      where: { roomId: 'r1', userId: 'u1', status: VideoRoomModerationStatus.ACTIVE },
    });
  });

  it('appendAction writes an append-only audit row (no id/update path)', async () => {
    await repo.appendAction({
      roomId: 'r1',
      moderatorId: 'mod',
      targetUserId: 'u1',
      action: VideoRoomModerationActionType.BLOCK,
    });
    expect(prisma.videoRoomModerationAction.create).toHaveBeenCalledWith({
      data: {
        roomId: 'r1',
        moderatorId: 'mod',
        targetUserId: 'u1',
        action: VideoRoomModerationActionType.BLOCK,
        reason: null,
        metadata: undefined,
      },
    });
  });

  it('exposes NO ban capability (Video Room has no ban feature)', () => {
    expect((repo as any).createBan).toBeUndefined();
    expect((repo as any).findActiveBan).toBeUndefined();
    expect(prisma.videoRoomBan).toBeUndefined();
  });
});
