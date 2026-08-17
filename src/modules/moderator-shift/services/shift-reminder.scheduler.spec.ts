import { Test, TestingModule } from '@nestjs/testing';
import { ShiftReminderScheduler } from './shift-reminder.scheduler';
import { ModeratorShiftService } from './moderator-shift.service';
import {
  NOTIFICATION_SERVICE,
  type INotificationService,
} from 'src/modules/notification/interfaces/notification.interface';

describe('ShiftReminderScheduler', () => {
  let scheduler: ShiftReminderScheduler;
  let shiftService: jest.Mocked<ModeratorShiftService>;
  let notifications: jest.Mocked<INotificationService>;

  beforeEach(async () => {
    shiftService = {
      getUpcomingShifts: jest.fn().mockResolvedValue([{ moderatorId: 'mod-1', shiftId: 's-1' }]),
      getEndingSoonShifts: jest.fn().mockResolvedValue([{ moderatorId: 'mod-2', shiftId: 's-2' }]),
    } as unknown as jest.Mocked<ModeratorShiftService>;

    notifications = {
      create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
    } as unknown as jest.Mocked<INotificationService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShiftReminderScheduler,
        { provide: ModeratorShiftService, useValue: shiftService },
        { provide: NOTIFICATION_SERVICE, useValue: notifications },
      ],
    }).compile();

    scheduler = module.get<ShiftReminderScheduler>(ShiftReminderScheduler);
  });

  it('sends MODERATOR_SHIFT_STARTING reminders through the real notification-publishing path', async () => {
    await scheduler.sendShiftStartingReminders();
    expect(shiftService.getUpcomingShifts).toHaveBeenCalledWith(15);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'mod-1',
        type: 'MODERATOR_SHIFT_STARTING',
      }),
    );
  });

  it('sends MODERATOR_SHIFT_ENDING reminders through the real notification-publishing path', async () => {
    await scheduler.sendShiftEndingReminders();
    expect(shiftService.getEndingSoonShifts).toHaveBeenCalledWith(15);
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'mod-2',
        type: 'MODERATOR_SHIFT_ENDING',
      }),
    );
  });

  it('does not throw when the notification create call fails (logged, not propagated)', async () => {
    notifications.create.mockRejectedValue(new Error('notif service down'));
    await expect(scheduler.sendShiftStartingReminders()).resolves.toBeUndefined();
  });
});
