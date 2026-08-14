import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { ModeratorShiftController } from './controllers/moderator-shift.controller';
import { ModeratorNotificationController } from './controllers/moderator-notification.controller';
import { ModeratorShiftService } from './services/moderator-shift.service';
import { ShiftReminderScheduler } from './services/shift-reminder.scheduler';
import { ModeratorNotificationService } from './services/moderator-notification.service';
import { ShiftActiveGuard } from './guards/shift-active.guard';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [ModeratorShiftController, ModeratorNotificationController],
  providers: [
    ModeratorShiftService,
    ShiftReminderScheduler,
    ShiftActiveGuard,
    ModeratorNotificationService,
  ],
  exports: [ModeratorShiftService, ShiftActiveGuard, ModeratorNotificationService],
})
export class ModeratorShiftModule {}
