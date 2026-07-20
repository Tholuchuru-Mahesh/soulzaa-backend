import { VideoRoomPublishRole, VideoRoomSessionStatus } from '@prisma/client';
import type { PrismaService } from 'src/infra/prisma/prisma.service';
import { VideoRoomMediaSessionRepository } from './video-room-media-session.repository';

describe('VideoRoomMediaSessionRepository', () => {
  let prisma: any;
  let repo: VideoRoomMediaSessionRepository;

  beforeEach(() => {
    prisma = {
      videoRoomSession: {
        upsert: jest.fn().mockResolvedValue({ id: 'sess1' }),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({ id: 'sess1' }),
      },
    };
    repo = new VideoRoomMediaSessionRepository(prisma as unknown as PrismaService);
  });

  it('start upserts on (roomId,userId); rejoin reactivates + bumps reconnectCount', async () => {
    await repo.start({ roomId: 'r1', userId: 'u1', zegoRoomId: 'z1' });
    const arg = prisma.videoRoomSession.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ roomId_userId: { roomId: 'r1', userId: 'u1' } });
    expect(arg.create).toMatchObject({
      zegoRoomId: 'z1',
      role: VideoRoomPublishRole.SUBSCRIBER,
      createdBy: 'u1',
    });
    // Reactivation semantics on the update branch:
    expect(arg.update.status).toBe(VideoRoomSessionStatus.ACTIVE);
    expect(arg.update.endedAt).toBeNull();
    expect(arg.update.reconnectCount).toEqual({ increment: 1 });
  });

  it('setRole switches the publish role (seat <-> audience)', async () => {
    await repo.setRole('r1', 'u1', VideoRoomPublishRole.PUBLISHER);
    const arg = prisma.videoRoomSession.update.mock.calls[0][0];
    expect(arg.where).toEqual({ roomId_userId: { roomId: 'r1', userId: 'u1' } });
    expect(arg.data.role).toBe(VideoRoomPublishRole.PUBLISHER);
  });

  it('end marks ENDED, stamps endedAt + duration', async () => {
    await repo.end('r1', 'u1', 120n);
    const data = prisma.videoRoomSession.update.mock.calls[0][0].data;
    expect(data.status).toBe(VideoRoomSessionStatus.ENDED);
    expect(data.endedAt).toBeInstanceOf(Date);
    expect(data.durationSeconds).toBe(120n);
  });

  it('listActive filters to ACTIVE sessions', async () => {
    await repo.listActive('r1');
    expect(prisma.videoRoomSession.findMany).toHaveBeenCalledWith({
      where: { roomId: 'r1', status: VideoRoomSessionStatus.ACTIVE },
      orderBy: { joinedAt: 'asc' },
    });
  });

  it('setSelfMedia updates self-mute + facing', async () => {
    prisma.videoRoomSession.update.mockResolvedValue({} as never);
    await repo.setSelfMedia('r', 'u1', { selfMutedVideo: true, cameraFacing: 'REAR' });
    expect(prisma.videoRoomSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { roomId_userId: { roomId: 'r', userId: 'u1' } },
        data: expect.objectContaining({ selfMutedVideo: true, cameraFacing: 'REAR' }),
      }),
    );
  });

  it('findStale queries ACTIVE sessions older than cutoff, oldest-first, capped at limit', async () => {
    const cutoff = new Date('2026-07-20T00:00:00.000Z');
    await repo.findStale(cutoff, 200);
    expect(prisma.videoRoomSession.findMany).toHaveBeenCalledWith({
      where: { status: VideoRoomSessionStatus.ACTIVE, lastHeartbeatAt: { lt: cutoff } },
      orderBy: { lastHeartbeatAt: 'asc' },
      take: 200,
    });
  });
});
