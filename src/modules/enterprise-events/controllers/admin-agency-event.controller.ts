import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { RejectAgencyEventDto } from '../dto/agency-event-review.dto';
import { AgencyEventReviewService } from '../services/agency-event-review.service';

/**
 * Agency Event Review. Separate from AdminChallengeController because the two
 * workflows only look alike: they share a table but not a category, and an
 * approved event is published onto the lifecycle scheduler.
 *
 * Gated on `event.manage`, which today means Admin and Super Admin. Officials
 * are the intended reviewers eventually; that is this one constant.
 */
@ApiTags('Admin Agency Event Review')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('admin/agency-events')
export class AdminAgencyEventController {
  constructor(private readonly review: AgencyEventReviewService) {}

  @Get()
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'List agency-submitted events for review' })
  @ApiQuery({ name: 'status', required: false })
  listAll(@Query('status') status?: string) {
    return this.review.listForAdmin(status);
  }

  @Get('pending')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'List agency events awaiting review' })
  listPending() {
    return this.review.listForAdmin('PENDING_APPROVAL');
  }

  @Post(':id/approve')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Approve a submitted event (→ SCHEDULED)' })
  @ApiResponse({ status: 400, description: 'The event is not awaiting review' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.review.approve(id, user.id);
  }

  @Post(':id/reject')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Reject a submitted event with a reason' })
  @ApiResponse({ status: 400, description: 'The event is not awaiting review' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectAgencyEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.review.reject(id, dto.reason, user.id);
  }
}
