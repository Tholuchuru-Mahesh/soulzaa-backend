import { ForbiddenException } from '@nestjs/common';
import { InvestigationRecordingService } from './investigation-recording.service';

const MODERATOR_ID = 'mod-1';
const TARGET_ID = 'target-1';
const ROOM_ID = 'room-1';

describe('InvestigationRecordingService', () => {
  let prisma: any;
  let scopeService: { assertModeratorInScope: jest.Mock };
  let service: InvestigationRecordingService;

  beforeEach(() => {
    prisma = {
      investigationRecording: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'rec-1',
            evidenceId: 'EVD-1',
            startedAt: new Date('2026-08-14T10:00:00Z'),
            completedAt: null,
            durationSeconds: null,
            status: 'ACTIVE',
            evidencePayload: null,
            violationReason: null,
            ...data,
          }),
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest
          .fn()
          .mockImplementation(({ data }: any) => Promise.resolve({ id: 'rec-1', ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    scopeService = { assertModeratorInScope: jest.fn().mockResolvedValue(undefined) };
    service = new InvestigationRecordingService(prisma, scopeService as any);
  });

  describe('findActiveRecording', () => {
    it('scopes the lookup to moderator, target, status, and roomId when given', async () => {
      await service.findActiveRecording(MODERATOR_ID, TARGET_ID, { roomId: ROOM_ID });
      expect(prisma.investigationRecording.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            moderatorId: MODERATOR_ID,
            targetUserId: TARGET_ID,
            status: 'ACTIVE',
            roomId: ROOM_ID,
          }),
        }),
      );
    });
  });

  describe('beginOrReuseRecording', () => {
    it('reuses an already-open recording instead of creating a duplicate', async () => {
      prisma.investigationRecording.findFirst.mockResolvedValue({ id: 'existing-rec' });
      const result = await service.beginOrReuseRecording({
        moderatorId: MODERATOR_ID,
        targetUserId: TARGET_ID,
        roomId: ROOM_ID,
      });
      expect(result).toEqual({ id: 'existing-rec' });
      expect(prisma.investigationRecording.create).not.toHaveBeenCalled();
    });

    it('opens a new recording with no reason when none is active yet', async () => {
      await service.beginOrReuseRecording({
        moderatorId: MODERATOR_ID,
        targetUserId: TARGET_ID,
        roomId: ROOM_ID,
      });
      expect(prisma.investigationRecording.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ violationReason: null, status: 'ACTIVE' }),
        }),
      );
    });
  });

  describe('completeRecording', () => {
    it('finalizes violationReason from the input when the row was opened without one', async () => {
      prisma.investigationRecording.findUnique.mockResolvedValue({
        id: 'rec-1',
        status: 'ACTIVE',
        violationReason: null,
        startedAt: new Date('2026-08-14T10:00:00Z'),
        evidencePayload: null,
      });
      await service.completeRecording({
        recordingId: 'rec-1',
        actionTaken: 'KICK',
        violationReason: 'harassment',
      });
      expect(prisma.investigationRecording.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ violationReason: 'harassment' }),
        }),
      );
    });

    it('keeps the original violationReason when the row already had one', async () => {
      prisma.investigationRecording.findUnique.mockResolvedValue({
        id: 'rec-1',
        status: 'ACTIVE',
        violationReason: 'original reason',
        startedAt: new Date('2026-08-14T10:00:00Z'),
        evidencePayload: null,
      });
      await service.completeRecording({
        recordingId: 'rec-1',
        actionTaken: 'KICK',
        violationReason: 'a different reason passed at completion',
      });
      expect(prisma.investigationRecording.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ violationReason: 'original reason' }),
        }),
      );
    });

    it('computes a real duration spanning startedAt to now', async () => {
      const startedAt = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
      prisma.investigationRecording.findUnique.mockResolvedValue({
        id: 'rec-1',
        status: 'ACTIVE',
        violationReason: 'reason',
        startedAt,
        evidencePayload: null,
      });
      await service.completeRecording({ recordingId: 'rec-1', actionTaken: 'KICK' });
      const [[call]] = prisma.investigationRecording.update.mock.calls;
      expect(call.data.durationSeconds).toBeGreaterThanOrEqual(290);
      expect(call.data.durationSeconds).toBeLessThanOrEqual(310);
    });
  });

  describe('expireStaleRecordings', () => {
    it('marks ACTIVE recordings older than the cutoff as FAILED', async () => {
      prisma.investigationRecording.updateMany.mockResolvedValue({ count: 3 });
      const count = await service.expireStaleRecordings(12);
      expect(count).toBe(3);
      expect(prisma.investigationRecording.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'ACTIVE',
            startedAt: expect.objectContaining({ lt: expect.any(Date) }),
          }),
          data: expect.objectContaining({ status: 'FAILED' }),
        }),
      );
    });

    it('returns 0 without a warning log when nothing is stale', async () => {
      prisma.investigationRecording.updateMany.mockResolvedValue({ count: 0 });
      const count = await service.expireStaleRecordings();
      expect(count).toBe(0);
    });
  });

  describe('getCaseView', () => {
    it('joins recordings and audit logs for the target when an audit log service is wired', async () => {
      const auditLog = { getAuditLogsForTarget: jest.fn().mockResolvedValue([{ id: 'log-1' }]) };
      const withAuditScopeService = {
        assertModeratorInScope: jest.fn().mockResolvedValue(undefined),
      };
      const withAudit = new InvestigationRecordingService(
        prisma,
        withAuditScopeService as any,
        auditLog as any,
      );
      prisma.investigationRecording.findMany.mockResolvedValue([{ id: 'rec-1' }]);

      const result = await withAudit.getCaseView(TARGET_ID);

      expect(prisma.investigationRecording.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { targetUserId: TARGET_ID } }),
      );
      expect(auditLog.getAuditLogsForTarget).toHaveBeenCalledWith(TARGET_ID);
      expect(result).toEqual({
        targetUserId: TARGET_ID,
        recordings: [{ id: 'rec-1' }],
        auditLogs: [{ id: 'log-1' }],
      });
    });

    it('returns an empty auditLogs array when no audit log service is wired', async () => {
      const result = await service.getCaseView(TARGET_ID);
      expect(result.auditLogs).toEqual([]);
    });
  });

  describe('beginRecording owner scope (defense in depth)', () => {
    it('checks scope when an ownerId is provided', async () => {
      await service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', roomId: 'room-1', ownerId: 'owner-1' });
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('mod-1', 'owner-1');
    });

    it('permits (skips the check) when no ownerId is given', async () => {
      await service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', roomId: 'room-1' });
      expect(scopeService.assertModeratorInScope).toHaveBeenCalledWith('mod-1', null);
    });

    it("rejects a moderator outside the owner's scope", async () => {
      scopeService.assertModeratorInScope.mockRejectedValue(new ForbiddenException('nope'));
      await expect(
        service.beginRecording({ moderatorId: 'mod-1', targetUserId: 'target-1', liveStreamId: 'stream-1', ownerId: 'owner-1' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.investigationRecording.create).not.toHaveBeenCalled();
    });
  });
});
