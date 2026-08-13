import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ModeratorShiftService } from './moderator-shift.service';
import { NotificationType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Fires MODERATOR_SHIFT_STARTING notifications 15 minutes before each moderator's shift.
 * Fires MODERATOR_SHIFT_ENDING notifications 15 minutes before shift end.
 * Runs every 5 minutes; individual notifications are idempotent via per-day uniqueness.
 */
@Injectable()
export class ShiftReminderScheduler {
  private readonly logger = new Logger(ShiftReminderScheduler.name);

  constructor(
    private readonly shiftService: ModeratorShiftService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendShiftStartingReminders(): Promise<void> {
    try {
      const upcoming = await this.shiftService.getUpcomingShifts(15);

      for (const { moderatorId } of upcoming) {
        await this.prisma.notification.create({
          data: {
            userId: moderatorId,
            type: NotificationType.MODERATOR_SHIFT_STARTING,
            data: { message: 'Your working shift starts in 15 minutes.' },
          },
        });
        this.logger.debug(`SHIFT_STARTING reminder sent to ${moderatorId}`);
      }
    } catch (err) {
      this.logger.error(`Shift starting reminder error: ${(err as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sendShiftEndingReminders(): Promise<void> {
    try {
      const endingSoon = await this.shiftService.getEndingSoonShifts(15);

      for (const { moderatorId } of endingSoon) {
        await this.prisma.notification.create({
          data: {
            userId: moderatorId,
            type: NotificationType.MODERATOR_SHIFT_ENDING,
            data: { message: 'Your working shift ends in 15 minutes.' },
          },
        });
        this.logger.debug(`SHIFT_ENDING reminder sent to ${moderatorId}`);
      }
    } catch (err) {
      this.logger.error(`Shift ending reminder error: ${(err as Error).message}`);
    }
  }
}
