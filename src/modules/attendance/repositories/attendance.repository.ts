import { Injectable } from '@nestjs/common';
import type { Prisma, AttendanceClaim, AttendanceLadderRung, UserAttendance } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface RecordClaimInput {
  userId: string;
  day: number;
  cycle: number;
  dayKey: string;
  coins: number;
  currency: AttendanceLadderRung['currency'];
  expAmount: number | null;
  cosmeticId: string | null;
  timezone: string;
  claimedAt: Date;
}

@Injectable()
export class AttendanceRepository {
  constructor(private readonly prisma: PrismaService) {}

  getState(userId: string): Promise<UserAttendance | null> {
    return this.prisma.userAttendance.findUnique({ where: { userId } });
  }

  getLadder(): Promise<AttendanceLadderRung[]> {
    return this.prisma.attendanceLadderRung.findMany({ orderBy: { day: 'asc' } });
  }

  getRung(day: number): Promise<AttendanceLadderRung | null> {
    return this.prisma.attendanceLadderRung.findUnique({ where: { day } });
  }

  /**
   * Writes the immutable claim row and advances the user's state. Runs inside
   * the caller's transaction so a failed payout leaves neither behind.
   */
  async recordClaim(
    tx: Prisma.TransactionClient,
    input: RecordClaimInput,
  ): Promise<AttendanceClaim> {
    const claim = await tx.attendanceClaim.create({
      data: {
        userId: input.userId,
        day: input.day,
        cycle: input.cycle,
        dayKey: input.dayKey,
        coins: input.coins,
        currency: input.currency,
        expAmount: input.expAmount,
        cosmeticId: input.cosmeticId,
        timezone: input.timezone,
        claimedAt: input.claimedAt,
      },
    });

    await tx.userAttendance.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        currentDay: input.day,
        cycleCount: input.cycle,
        lastClaimDayKey: input.dayKey,
        lastClaimAt: input.claimedAt,
        lastClaimTimezone: input.timezone,
        totalClaims: 1,
      },
      update: {
        currentDay: input.day,
        cycleCount: input.cycle,
        lastClaimDayKey: input.dayKey,
        lastClaimAt: input.claimedAt,
        lastClaimTimezone: input.timezone,
        totalClaims: { increment: 1 },
      },
    });

    return claim;
  }
}
