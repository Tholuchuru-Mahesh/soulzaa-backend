import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ModeratorDeviceBindingService } from '../services/moderator-device-binding.service';

class RequestDeviceChangeDto {
  oldDeviceId?: string;
  newDeviceInfo!: Record<string, unknown>;
  reason?: string;
}

class ReviewDeviceChangeDto {
  reviewNote?: string;
}

@ApiTags('moderator-device')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderator/device-change')
export class ModeratorDeviceChangeController {
  constructor(private readonly service: ModeratorDeviceBindingService) {}

  @Post()
  @RequirePermissions('moderator.device.request')
  @ApiOperation({ summary: 'Moderator requests to change bound physical device' })
  requestChange(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestDeviceChangeDto) {
    return this.service.requestDeviceChange({
      moderatorId: user.id,
      oldDeviceId: dto.oldDeviceId,
      newDeviceInfo: dto.newDeviceInfo,
      reason: dto.reason,
    });
  }

  @Get('my-requests')
  @RequirePermissions('moderator.device.request')
  @ApiOperation({ summary: 'Moderator views their submitted device change requests' })
  myRequests(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getModeratorRequests(user.id);
  }

  @Get('pending')
  @RequirePermissions('moderator.device.review')
  @ApiOperation({ summary: 'List all pending device change requests (Manager/Admin)' })
  pending() {
    return this.service.getPendingRequests();
  }

  @Put(':id/manager-review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.device.review')
  @ApiOperation({ summary: 'Manager review stage for device change request (Country/Regional Manager)' })
  managerReview(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewDeviceChangeDto,
  ) {
    return this.service.managerReviewDeviceChange(id, user.id, dto.reviewNote);
  }

  @Put(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.device.review')
  @ApiOperation({ summary: 'Approve a device change request (Admin final approval + auto device registration)' })
  approve(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewDeviceChangeDto,
  ) {
    return this.service.approveDeviceChange(id, user.id, dto.reviewNote);
  }

  @Put(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('moderator.device.review')
  @ApiOperation({ summary: 'Reject a device change request (Manager/Admin)' })
  reject(
    @Param('id', ParseUuidPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReviewDeviceChangeDto,
  ) {
    return this.service.rejectDeviceChange(id, user.id, dto.reviewNote);
  }
}
