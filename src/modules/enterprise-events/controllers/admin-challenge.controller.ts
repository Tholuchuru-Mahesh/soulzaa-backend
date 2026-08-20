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
import { RejectChallengeDto } from '../dto/challenge.dto';
import { ChallengeService } from '../services/challenge.service';

@ApiTags('Admin Challenges Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@UseInterceptors(AuditLogInterceptor)
@Controller('admin/challenges')
export class AdminChallengeController {
  constructor(private readonly challenges: ChallengeService) {}

  @Get()
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'List all agency challenges for review' })
  @ApiQuery({ name: 'status', required: false })
  listAll(@Query('status') status?: string) {
    return this.challenges.listAllForAdmin(status);
  }

  @Get('pending')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'List pending agency challenges awaiting review' })
  listPending() {
    return this.challenges.listAllForAdmin('PENDING_APPROVAL');
  }

  @Post(':id/approve')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Approve a submitted challenge' })
  @ApiResponse({ status: 200, description: 'Challenge approved' })
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.challenges.approveChallenge(id, user.id);
  }

  @Post(':id/reject')
  @RequirePermissions('event.manage')
  @ApiOperation({ summary: 'Reject a submitted challenge with reason' })
  @ApiResponse({ status: 200, description: 'Challenge rejected' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectChallengeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.challenges.rejectChallenge(id, dto.reason, user.id);
  }
}
