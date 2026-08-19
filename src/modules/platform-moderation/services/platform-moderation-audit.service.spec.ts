import { PlatformModerationAuditService } from './platform-moderation-audit.service';

describe('PlatformModerationAuditService', () => {
  let prisma: { platformModerationAuditLog: Record<string, jest.Mock> };
  let service: PlatformModerationAuditService;

  beforeEach(() => {
    prisma = {
      platformModerationAuditLog: {
        create: jest.fn().mockResolvedValue({ id: 'log-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new PlatformModerationAuditService(prisma as never);
  });

  it('record() writes a row with the given fields', async () => {
    await service.record({
      moderatorId: 'm1',
      action: 'INCOGNITO_JOIN',
      roomType: 'AUDIO_ROOM',
      roomId: 'r1',
    });
    expect(prisma.platformModerationAuditLog.create).toHaveBeenCalledWith({
      data: {
        moderatorId: 'm1',
        action: 'INCOGNITO_JOIN',
        roomType: 'AUDIO_ROOM',
        roomId: 'r1',
        targetUserId: null,
        reason: null,
        scope: null,
      },
    });
  });

  it('record() persists scope on a WARNING_SENT row', async () => {
    await service.record({
      moderatorId: 'm1',
      action: 'WARNING_SENT',
      roomType: 'AUDIO_ROOM',
      roomId: 'r1',
      targetUserId: 't1',
      reason: 'be nice',
      scope: 'ROOM',
    });
    expect(prisma.platformModerationAuditLog.create).toHaveBeenCalledWith({
      data: {
        moderatorId: 'm1',
        action: 'WARNING_SENT',
        roomType: 'AUDIO_ROOM',
        roomId: 'r1',
        targetUserId: 't1',
        reason: 'be nice',
        scope: 'ROOM',
      },
    });
  });

  it('record() never throws — a logging failure must not break the caller', async () => {
    prisma.platformModerationAuditLog.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.record({
        moderatorId: 'm1',
        action: 'BAN_ISSUED',
        roomType: 'VIDEO_ROOM',
        roomId: 'r1',
      }),
    ).resolves.toBeUndefined();
  });
});
