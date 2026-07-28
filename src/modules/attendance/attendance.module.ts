import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { RedisModule } from 'src/infra/redis/redis.module';
import { AttendanceController } from './controllers/attendance.controller';
import { AttendanceRepository } from './repositories/attendance.repository';
import { AttendanceDayService } from './services/attendance-day.service';
import { AttendanceLadderSeeder } from './services/attendance-ladder.seeder';
import { AttendanceStreakService } from './services/attendance-streak.service';
import { AttendanceService } from './services/attendance.service';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [AttendanceController],
  providers: [
    AttendanceRepository,
    AttendanceDayService,
    AttendanceStreakService,
    AttendanceService,
    AttendanceLadderSeeder,
  ],
  exports: [AttendanceService],
})
export class AttendanceModule {}
