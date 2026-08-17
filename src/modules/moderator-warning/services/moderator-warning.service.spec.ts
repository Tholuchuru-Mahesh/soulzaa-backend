import { NotFoundException } from '@nestjs/common';
import { ModeratorWarningLevel, ModeratorWarningStatus } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { INotificationService } from 'src/modules/notification/interfaces/notification.interface';
import { ModeratorPerformanceService } from 'src/modules/moderator-performance/services/moderator-performance.service';
import { ModeratorWarningService } from './moderator-warning.service';

const MODERATOR_ID = 'mod-1';
const ISSUER_ID = 'manager-1';

describe('ModeratorWarningService', () => {
  let prisma: any;
  let notifications: jest.Mocked<INotificationService>;
  let performanceStats: jest.Mocked<Pick<ModeratorPerformanceService, 'recordAction'>>;
  let service: ModeratorWarningService;

  beforeEach(() => {
    prisma = {
      moderatorWarningRecord: {
        create: jest.fn().mockResolvedValue({ id: 'warn-1' }),
        findUnique: jest.fn(),
        update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'warn-1', ...data })),
        count: jest.fn().mockResolvedValue(0),
      },
      role: { findFirst: jest.fn().mockResolvedValue({ id: 'role-mod' }) },
      userRole: { updateMany: jest.fn().mockResolvedValue({}) },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) } as unknown as jest.Mocked<INotificationService>;
    performanceStats = { recordAction: jest.fn().mockResolvedValue(undefined) };
    service = new ModeratorWarningService(
      prisma as unknown as PrismaService,
      notifications,
      performanceStats as unknown as ModeratorPerformanceService,
    );
  });

  describe('issueWarning', () => {
    it('notifies the moderator through the real notification-publishing path', async () => {
      await service.issueWarning({
        moderatorId: MODERATOR_ID,
        issuedBy: ISSUER_ID,
        level: ModeratorWarningLevel.LEVEL_1,
        reason: 'late response times',
      });

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: MODERATOR_ID,
          type: 'MODERATOR_WARNING_ISSUED',
          actorId: ISSUER_ID,
        }),
      );
    });

    it('records the WARN action against the issuer for performance tracking', async () => {
      await service.issueWarning({
        moderatorId: MODERATOR_ID,
        issuedBy: ISSUER_ID,
        level: ModeratorWarningLevel.LEVEL_1,
        reason: 'reason',
      });
      expect(performanceStats.recordAction).toHaveBeenCalledWith(ISSUER_ID, 'WARN');
    });

    it('flags Level 2 warnings as pending Country Manager review', async () => {
      await service.issueWarning({
        moderatorId: MODERATOR_ID,
        issuedBy: ISSUER_ID,
        level: ModeratorWarningLevel.LEVEL_2,
        reason: 'reason',
      });
      expect(prisma.moderatorWarningRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            description: expect.stringContaining('[PENDING_COUNTRY_MANAGER_REVIEW]'),
          }),
        }),
      );
      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ requiresCountryManagerReview: true }) }),
      );
    });

    it('suspends the Moderator role on a Level 3 warning', async () => {
      await service.issueWarning({
        moderatorId: MODERATOR_ID,
        issuedBy: ISSUER_ID,
        level: ModeratorWarningLevel.LEVEL_3,
        reason: 'repeated policy violations',
      });

      expect(prisma.userRole.updateMany).toHaveBeenCalledWith({
        where: { userId: MODERATOR_ID, roleId: 'role-mod' },
        data: expect.objectContaining({ suspendedAt: expect.any(Date), suspendedBy: ISSUER_ID }),
      });
    });

    it('does not suspend anything for Level 1/2 warnings', async () => {
      await service.issueWarning({
        moderatorId: MODERATOR_ID,
        issuedBy: ISSUER_ID,
        level: ModeratorWarningLevel.LEVEL_1,
        reason: 'reason',
      });
      expect(prisma.userRole.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('resolveWarning', () => {
    it('restores the Moderator role once no other active Level 3 warning remains', async () => {
      prisma.moderatorWarningRecord.findUnique.mockResolvedValue({
        id: 'warn-1',
        moderatorId: MODERATOR_ID,
        level: ModeratorWarningLevel.LEVEL_3,
      });
      prisma.moderatorWarningRecord.count.mockResolvedValue(0);

      await service.resolveWarning('warn-1', 'admin-1', 'reviewed, restoring access');

      expect(prisma.userRole.updateMany).toHaveBeenCalledWith({
        where: { userId: MODERATOR_ID, roleId: 'role-mod' },
        data: { suspendedAt: null, suspendedBy: null },
      });
    });

    it('leaves the suspension in place while another active Level 3 warning remains', async () => {
      prisma.moderatorWarningRecord.findUnique.mockResolvedValue({
        id: 'warn-1',
        moderatorId: MODERATOR_ID,
        level: ModeratorWarningLevel.LEVEL_3,
      });
      prisma.moderatorWarningRecord.count.mockResolvedValue(1);

      await service.resolveWarning('warn-1', 'admin-1');

      expect(prisma.userRole.updateMany).not.toHaveBeenCalled();
    });

    it('throws when the warning does not exist', async () => {
      prisma.moderatorWarningRecord.findUnique.mockResolvedValue(null);
      await expect(service.resolveWarning('missing', 'admin-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('isSuspended', () => {
    it('is true when an active Level 3 warning exists', async () => {
      prisma.moderatorWarningRecord.count.mockResolvedValue(1);
      await expect(service.isSuspended(MODERATOR_ID)).resolves.toBe(true);
    });

    it('is false otherwise', async () => {
      prisma.moderatorWarningRecord.count.mockResolvedValue(0);
      await expect(service.isSuspended(MODERATOR_ID)).resolves.toBe(false);
    });
  });
});
