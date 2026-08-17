import { PrismaService } from 'src/infra/prisma/prisma.service';
import type { INotificationService } from 'src/modules/notification/interfaces/notification.interface';
import { ModeratorNotificationService } from './moderator-notification.service';

describe('ModeratorNotificationService — real notification-publishing path', () => {
  let prisma: {
    moderator_task_assignments: { findMany: jest.Mock };
    taskDefinition: { findMany: jest.Mock };
    userRole: { findMany: jest.Mock };
  };
  let notifications: jest.Mocked<INotificationService>;
  let service: ModeratorNotificationService;

  beforeEach(() => {
    prisma = {
      moderator_task_assignments: { findMany: jest.fn().mockResolvedValue([]) },
      taskDefinition: {
        findMany: jest.fn().mockResolvedValue([{ id: 't-1', name: 'Review 100 Reports' }]),
      },
      userRole: { findMany: jest.fn().mockResolvedValue([]) },
    };
    notifications = { create: jest.fn().mockResolvedValue({}) } as unknown as jest.Mocked<INotificationService>;
    service = new ModeratorNotificationService(
      prisma as unknown as PrismaService,
      notifications,
    );
  });

  it('sends MODERATOR_TASK_DUE_SOON through the real path for each due assignment', async () => {
    prisma.moderator_task_assignments.findMany.mockResolvedValue([
      { id: 'a-1', moderatorId: 'mod-1', taskId: 't-1', dueAt: new Date() },
    ]);

    await service.sendTaskDueSoonReminders();

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_TASK_DUE_SOON' }),
    );
  });

  it('sends MODERATOR_HIGH_PRIORITY_REPORT to a single moderator', async () => {
    await service.notifyHighPriorityReport('mod-1', 'report-1', 'multiple abuse flags');
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'mod-1',
      type: 'MODERATOR_HIGH_PRIORITY_REPORT',
      data: { reportId: 'report-1', reason: 'multiple abuse flags' },
    });
  });

  it('sends MODERATOR_REPORT_ASSIGNED with the assigner as actor', async () => {
    await service.notifyReportAssigned('mod-1', 'report-1', 'official-1');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_REPORT_ASSIGNED', actorId: 'official-1' }),
    );
  });

  it('sends MODERATOR_EMERGENCY_REQUEST to every recipient', async () => {
    await service.sendEmergencyRequest(['mod-1', 'mod-2'], 'official-1', 'evacuate room X');
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_EMERGENCY_REQUEST' }),
    );
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-2', type: 'MODERATOR_EMERGENCY_REQUEST' }),
    );
  });

  it('broadcasts MODERATOR_POLICY_UPDATE to every moderator', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ userId: 'mod-1' }, { userId: 'mod-2' }]);
    await service.broadcastPolicyUpdate('admin-1', 'New Policy', 'body text');
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_POLICY_UPDATE', actorId: 'admin-1' }),
    );
  });

  it('sends MODERATOR_OFFICIAL_MESSAGE to specific moderators', async () => {
    await service.sendOfficialMessage(['mod-1'], 'official-1', 'Heads up', 'watch region X');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_OFFICIAL_MESSAGE' }),
    );
  });

  it('sends MODERATOR_MANAGER_INSTRUCTION to specific moderators', async () => {
    await service.sendManagerInstruction(['mod-1'], 'manager-1', 'Priority', 'focus on X', 'URGENT');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_MANAGER_INSTRUCTION' }),
    );
  });

  it('broadcasts MODERATOR_SYSTEM_ANNOUNCEMENT to every moderator', async () => {
    prisma.userRole.findMany.mockResolvedValue([{ userId: 'mod-1' }]);
    await service.broadcastSystemAnnouncement('admin-1', 'Maintenance', 'window at midnight');
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'mod-1', type: 'MODERATOR_SYSTEM_ANNOUNCEMENT' }),
    );
  });
});
