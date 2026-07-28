import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ATTENDANCE_LADDER_SEED } from '../constants/attendance.constants';

/**
 * Seeds the 30-rung ladder on a fresh database. Idempotent by day and
 * create-only: operator edits to coins, EXP or the attached cosmetic survive a
 * restart. A claim cannot resolve without its rung, so this guarantees the
 * feature is usable out of the box.
 */
@Injectable()
export class AttendanceLadderSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(AttendanceLadderSeeder.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      let created = 0;
      for (const seed of ATTENDANCE_LADDER_SEED) {
        const existing = await this.prisma.attendanceLadderRung.findUnique({
          where: { day: seed.day },
        });
        if (existing) continue;
        await this.prisma.attendanceLadderRung.create({
          data: { day: seed.day, coins: seed.coins, expAmount: seed.expAmount },
        });
        created += 1;
      }
      if (created > 0) this.logger.log(`Seeded ${created} attendance ladder rung(s).`);
    } catch (err) {
      this.logger.warn(`Attendance ladder seed skipped: ${(err as Error).message}`);
    }
  }
}
