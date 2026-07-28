import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { NotGuest } from 'src/common/decorators/not-guest.decorator';
import { AttendanceClaimDto, AttendanceStatusDto } from '../dto/attendance.dto';
import { AttendanceService } from '../services/attendance.service';

/**
 * Daily-login streak (base `attendance`). JWT-guarded globally. Claiming is
 * explicit — logging in does not pay.
 */
@ApiTags('attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @ApiOperation({ summary: 'Current streak, whether today is claimable, and the ladder' })
  @ApiResponse({ status: 200, type: AttendanceStatusDto })
  status(@CurrentUser('id') userId: string) {
    return this.attendance.getStatus(userId);
  }

  @Post('claim')
  @NotGuest()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Claim today's reward" })
  @ApiResponse({ status: 200, type: AttendanceClaimDto })
  @ApiResponse({ status: 403, description: 'Attendance rewards are disabled' })
  @ApiResponse({ status: 409, description: 'Claim window not open after a country change' })
  claim(@CurrentUser('id') userId: string) {
    return this.attendance.claim(userId);
  }
}
