import { Test, TestingModule } from '@nestjs/testing';
import { ShiftReminderScheduler } from './shift-reminder.scheduler';
import { ModeratorShiftService } from './moderator-shift.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';

describe('ShiftReminderScheduler', () => {
  let scheduler: ShiftReminderScheduler;
  let shiftService: jest.Mocked<ModeratorShiftService>;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    shiftService = {
      getUpcomingShifts: jest.fn().mockResolvedValue([{ moderatorId: 'mod-1', shiftId: 's-1' }]),
      getEndingSoonShifts: jest.fn().mockResolvedValue([{ moderatorId: 'mod-2', shiftId: 's-2' }]),
    } as unknown as jest.Mocked<ModeratorShiftService>;

    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({ id: 'notif-1' }),
      },
    } as unknown as jest.Mocked<PrismaService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShiftReminderScheduler,
        { provide: ModeratorShiftService, useValue: shiftService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    scheduler = module.get<ShiftReminderScheduler>(ShiftReminderScheduler);
  });

  it('should send MODERATOR_SHIFT_STARTING reminders', async () => {
    await scheduler.sendShiftStartingReminders();
    expect(shiftService.getUpcomingShifts).toHaveBeenCalledWith(15);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'mod-1',
          type: 'MODERATOR_SHIFT_STARTING',
        }),
      }),
    );
  });

  it('should send MODERATOR_SHIFT_ENDING reminders', async () => {
    await scheduler.sendShiftEndingReminders();
    expect(shiftService.getEndingSoonShifts).toHaveBeenCalledWith(15);
    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'mod-2',
          type: 'MODERATOR_SHIFT_ENDING',
        }),
      }),
    );
  });
});
