import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { DayOfWeek } from '@prisma/client';
import { ModeratorShiftService } from '../services/moderator-shift.service';

class AssignShiftDto {
  daysOfWeek!: DayOfWeek[];
  startHour!: number;
  startMinute!: number;
  endHour!: number;
  endMinute!: number;
  timezone?: string;
  label?: string;
}

class AddOverrideDto {
  overrideDate!: string; // ISO date string "YYYY-MM-DD"
  startHour!: number;
  startMinute!: number;
  endHour!: number;
  endMinute!: number;
  reason?: string;
}

@ApiTags('moderator-shift')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderator/shifts')
export class ModeratorShiftController {
  constructor(private readonly shiftService: ModeratorShiftService) {}

  @Post(':moderatorId')
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: 'Assign a working shift to a moderator (Admin only)' })
  assignShift(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Body() dto: AssignShiftDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.shiftService.assignShift({ ...dto, moderatorId, assignedBy: actor.id });
  }

  @Get('me')
  @RequirePermissions('moderator.shift.view')
  @ApiOperation({ summary: "Get the calling moderator's active shift + status" })
  async myShift(@CurrentUser() user: AuthenticatedUser) {
    return this.shiftService.shiftStatus(user.id);
  }

  @Get('me/active')
  @RequirePermissions('moderator.shift.view')
  @ApiOperation({ summary: 'Returns whether the moderator is currently within their shift' })
  async isActive(@CurrentUser() user: AuthenticatedUser) {
    const isActive = await this.shiftService.isWithinShift(user.id);
    return { isActive };
  }

  @Get(':moderatorId')
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: "Get a specific moderator's shift (Admin/Manager)" })
  getShift(@Param('moderatorId', ParseUuidPipe) moderatorId: string) {
    return this.shiftService.getActiveShift(moderatorId);
  }

  @Get()
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: 'List all shifts (Admin/Manager)' })
  listShifts(@Query('isActive') isActive?: string) {
    return this.shiftService.listShifts({
      isActive: isActive !== undefined ? isActive === 'true' : undefined,
    });
  }

  @Put(':id')
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: 'Update a shift' })
  updateShift(@Param('id', ParseUuidPipe) id: string, @Body() dto: Partial<AssignShiftDto>) {
    return this.shiftService.updateShift(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: 'Deactivate (soft-delete) a shift' })
  async deactivateShift(@Param('id', ParseUuidPipe) id: string) {
    await this.shiftService.deactivateShift(id);
    return { deactivated: true };
  }

  @Post(':id/overrides')
  @RequirePermissions('moderator.shift.manage')
  @ApiOperation({ summary: 'Add or replace a date-specific shift override' })
  async addOverride(
    @Param('id', ParseUuidPipe) id: string,
    @Body() dto: AddOverrideDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const shift = await this.shiftService.getShiftById(id);
    return this.shiftService.addOverride({
      shiftId: id,
      moderatorId: shift.moderatorId,
      overrideDate: new Date(dto.overrideDate),
      startHour: dto.startHour,
      startMinute: dto.startMinute,
      endHour: dto.endHour,
      endMinute: dto.endMinute,
      reason: dto.reason,
      createdBy: actor.id,
    });
  }
}
