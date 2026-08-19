import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { DayOfWeek } from '@prisma/client';

export interface CreateShiftInput {
  moderatorId: string;
  daysOfWeek: DayOfWeek[];
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timezone?: string;
  label?: string;
  assignedBy: string;
}

export interface CreateOverrideInput {
  shiftId: string;
  moderatorId: string;
  overrideDate: Date;
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  reason?: string;
  createdBy: string;
}

const DOW_MAP: Record<number, DayOfWeek> = {
  1: DayOfWeek.MONDAY,
  2: DayOfWeek.TUESDAY,
  3: DayOfWeek.WEDNESDAY,
  4: DayOfWeek.THURSDAY,
  5: DayOfWeek.FRIDAY,
  6: DayOfWeek.SATURDAY,
  0: DayOfWeek.SUNDAY,
};

@Injectable()
export class ModeratorShiftService {
  private readonly logger = new Logger(ModeratorShiftService.name);

  constructor(private readonly prisma: PrismaService) {}

  async assignShift(input: CreateShiftInput) {
    // Deactivate any existing active shift for this moderator
    await this.prisma.moderatorShift.updateMany({
      where: { moderatorId: input.moderatorId, isActive: true },
      data: { isActive: false },
    });

    return this.prisma.moderatorShift.create({
      data: {
        moderatorId: input.moderatorId,
        daysOfWeek: input.daysOfWeek,
        startHour: input.startHour,
        startMinute: input.startMinute,
        endHour: input.endHour,
        endMinute: input.endMinute,
        timezone: input.timezone ?? 'UTC',
        label: input.label,
        assignedBy: input.assignedBy,
      },
    });
  }

  async getActiveShift(moderatorId: string) {
    return this.prisma.moderatorShift.findFirst({
      where: { moderatorId, isActive: true },
    });
  }

  async getShiftById(id: string) {
    const shift = await this.prisma.moderatorShift.findUnique({
      where: { id },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    return shift;
  }

  async updateShift(id: string, input: Partial<CreateShiftInput>) {
    await this.getShiftById(id);
    const { assignedBy: _ignored, moderatorId: _mod, ...rest } = input;
    return this.prisma.moderatorShift.update({ where: { id }, data: rest });
  }

  async deactivateShift(id: string) {
    await this.getShiftById(id);
    return this.prisma.moderatorShift.update({ where: { id }, data: { isActive: false } });
  }

  async addOverride(input: CreateOverrideInput) {
    const overrideDate = new Date(input.overrideDate);
    return this.prisma.shiftOverride.upsert({
      where: { shiftId_overrideDate: { shiftId: input.shiftId, overrideDate } },
      create: {
        shiftId: input.shiftId,
        moderatorId: input.moderatorId,
        overrideDate,
        startHour: input.startHour,
        startMinute: input.startMinute,
        endHour: input.endHour,
        endMinute: input.endMinute,
        reason: input.reason,
        createdBy: input.createdBy,
      },
      update: {
        startHour: input.startHour,
        startMinute: input.startMinute,
        endHour: input.endHour,
        endMinute: input.endMinute,
        reason: input.reason,
      },
    });
  }

  private getTimeInTimezone(
    now: Date,
    timezone?: string,
  ): { hours: number; minutes: number; dayOfWeek: DayOfWeek } {
    const tz = timezone && timezone.trim() !== '' ? timezone : 'UTC';
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
      const parts = formatter.formatToParts(now);
      const hStr = parts.find((p) => p.type === 'hour')?.value ?? '0';
      const mStr = parts.find((p) => p.type === 'minute')?.value ?? '0';
      const wStr = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';

      const dowMap: Record<string, DayOfWeek> = {
        Mon: DayOfWeek.MONDAY,
        Tue: DayOfWeek.TUESDAY,
        Wed: DayOfWeek.WEDNESDAY,
        Thu: DayOfWeek.THURSDAY,
        Fri: DayOfWeek.FRIDAY,
        Sat: DayOfWeek.SATURDAY,
        Sun: DayOfWeek.SUNDAY,
      };

      const parsedH = parseInt(hStr, 10);
      return {
        hours: parsedH === 24 ? 0 : parsedH,
        minutes: parseInt(mStr, 10),
        dayOfWeek: dowMap[wStr] ?? DayOfWeek.MONDAY,
      };
    } catch {
      return {
        hours: now.getUTCHours(),
        minutes: now.getUTCMinutes(),
        dayOfWeek: DOW_MAP[now.getUTCDay()],
      };
    }
  }

  /**
   * Returns true if the moderator's shift is currently active.
   * Checks overrides first; falls back to the recurring schedule.
   * Compares time using the shift's configured timezone.
   */
  async isWithinShift(moderatorId: string): Promise<boolean> {
    const shift = await this.getActiveShift(moderatorId);
    if (!shift) return false;

    const now = new Date();
    const timeInTz = this.getTimeInTimezone(now, shift.timezone);
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    // Check for a date-specific override first.
    const override = await this.prisma.shiftOverride.findUnique({
      where: { shiftId_overrideDate: { shiftId: shift.id, overrideDate: todayUtc } },
    });

    if (override) {
      return this.isInWindow(
        timeInTz.hours,
        timeInTz.minutes,
        override.startHour,
        override.startMinute,
        override.endHour,
        override.endMinute,
      );
    }

    // Check recurring schedule.
    if (!shift.daysOfWeek.includes(timeInTz.dayOfWeek)) return false;

    return this.isInWindow(
      timeInTz.hours,
      timeInTz.minutes,
      shift.startHour,
      shift.startMinute,
      shift.endHour,
      shift.endMinute,
    );
  }

  private isInWindow(
    currentH: number,
    currentM: number,
    startH: number,
    startM: number,
    endH: number,
    endM: number,
  ): boolean {
    const currentMinutes = currentH * 60 + currentM;
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    // Handles overnight shifts (e.g., 22:00 – 06:00).
    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  /** Countdown in seconds to the next shift window for a moderator. */
  async shiftStatus(moderatorId: string): Promise<{
    isActive: boolean;
    shift: Awaited<ReturnType<ModeratorShiftService['getActiveShift']>>;
    nextShiftStartsInSeconds: number | null;
  }> {
    const shift = await this.getActiveShift(moderatorId);
    if (!shift) return { isActive: false, shift: null, nextShiftStartsInSeconds: null };

    const active = await this.isWithinShift(moderatorId);

    if (active) return { isActive: true, shift, nextShiftStartsInSeconds: null };

    // Calculate seconds to next start window on the next scheduled day in timezone.
    const now = new Date();
    const timeInTz = this.getTimeInTimezone(now, shift.timezone);
    const currentMinutes = timeInTz.hours * 60 + timeInTz.minutes;
    const startMinutes = shift.startHour * 60 + shift.startMinute;

    const DOW_ORDER: DayOfWeek[] = [
      DayOfWeek.SUNDAY,
      DayOfWeek.MONDAY,
      DayOfWeek.TUESDAY,
      DayOfWeek.WEDNESDAY,
      DayOfWeek.THURSDAY,
      DayOfWeek.FRIDAY,
      DayOfWeek.SATURDAY,
    ];
    const currentDayIdx = DOW_ORDER.indexOf(timeInTz.dayOfWeek);

    // Find next scheduled day (within the next 7 days).
    let daysUntilNext: number | null = null;
    for (let d = 0; d <= 7; d++) {
      const candidate = DOW_ORDER[(currentDayIdx + d) % 7];
      if (shift.daysOfWeek.includes(candidate)) {
        if (d === 0 && currentMinutes >= startMinutes) continue; // today already passed
        daysUntilNext = d;
        break;
      }
    }

    if (daysUntilNext === null) return { isActive: false, shift, nextShiftStartsInSeconds: null };

    const minutesUntilStart =
      daysUntilNext * 24 * 60 + ((startMinutes - currentMinutes + 1440) % 1440);

    return { isActive: false, shift, nextShiftStartsInSeconds: minutesUntilStart * 60 };
  }

  /** Returns all upcoming shifts starting within the next windowMinutes (for reminder scheduler). */
  async getUpcomingShifts(
    windowMinutes = 15,
  ): Promise<Array<{ moderatorId: string; shiftId: string }>> {
    const allActive = await this.prisma.moderatorShift.findMany({ where: { isActive: true } });
    const result: Array<{ moderatorId: string; shiftId: string }> = [];

    for (const shift of allActive) {
      const now = new Date();
      const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const startMinutes = shift.startHour * 60 + shift.startMinute;
      const todayDow = DOW_MAP[now.getUTCDay()];

      if (!shift.daysOfWeek.includes(todayDow)) continue;

      const diff = startMinutes - currentMinutes;
      if (diff > 0 && diff <= windowMinutes) {
        result.push({ moderatorId: shift.moderatorId, shiftId: shift.id });
      }
    }

    return result;
  }

  /** Returns all shifts ending within the next windowMinutes (for reminder scheduler). */
  async getEndingSoonShifts(
    windowMinutes = 15,
  ): Promise<Array<{ moderatorId: string; shiftId: string }>> {
    const allActive = await this.prisma.moderatorShift.findMany({ where: { isActive: true } });
    const result: Array<{ moderatorId: string; shiftId: string }> = [];

    for (const shift of allActive) {
      const now = new Date();
      const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
      const endMinutes = shift.endHour * 60 + shift.endMinute;
      const todayDow = DOW_MAP[now.getUTCDay()];

      if (!shift.daysOfWeek.includes(todayDow)) continue;

      const diff = endMinutes - currentMinutes;
      if (diff > 0 && diff <= windowMinutes) {
        result.push({ moderatorId: shift.moderatorId, shiftId: shift.id });
      }
    }

    return result;
  }

  async listShifts(filters: { moderatorId?: string; isActive?: boolean }) {
    return this.prisma.moderatorShift.findMany({
      where: {
        ...(filters.moderatorId ? { moderatorId: filters.moderatorId } : {}),
        ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}
