import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { ModeratorPerformanceService } from '../services/moderator-performance.service';

@ApiTags('moderator-performance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderator/performance')
export class ModeratorPerformanceSelfController {
  constructor(private readonly service: ModeratorPerformanceService) {}

  @Get('me')
  @RequirePermissions('moderator.performance.view.self')
  @ApiOperation({ summary: "Moderator views their own performance summary" })
  mySummary(@CurrentUser() user: AuthenticatedUser) {
    return this.service.getSummary(user.id);
  }

  @Get('me/daily')
  @RequirePermissions('moderator.performance.view.self')
  @ApiOperation({ summary: "Moderator views their daily stats (optional ?date=YYYY-MM-DD)" })
  myDaily(@CurrentUser() user: AuthenticatedUser, @Query('date') date?: string) {
    return this.service.getDaily(user.id, date);
  }

  @Get('me/range')
  @RequirePermissions('moderator.performance.view.self')
  @ApiOperation({ summary: 'Moderator views stats for a date range (?from=YYYY-MM-DD&to=YYYY-MM-DD)' })
  myRange(
    @CurrentUser() user: AuthenticatedUser,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.getRange(user.id, from, to);
  }
}

@ApiTags('moderator-performance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('admin/performance/moderators')
export class ModeratorPerformanceAdminController {
  constructor(private readonly service: ModeratorPerformanceService) {}

  @Get()
  @RequirePermissions('moderator.performance.view.all')
  @ApiOperation({ summary: 'All moderators KPI for a date (Manager/Admin)' })
  all(@Query('date') date?: string) {
    return this.service.getAllModeratorStats(date);
  }

  @Get(':moderatorId')
  @RequirePermissions('moderator.performance.view.all')
  @ApiOperation({ summary: "Single moderator's performance summary (Manager/Admin)" })
  single(@Param('moderatorId', ParseUuidPipe) moderatorId: string) {
    return this.service.getSummary(moderatorId);
  }

  @Get(':moderatorId/daily')
  @RequirePermissions('moderator.performance.view.all')
  @ApiOperation({ summary: "Single moderator's daily stats (Manager/Admin)" })
  singleDaily(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Query('date') date?: string,
  ) {
    return this.service.getDaily(moderatorId, date);
  }

  @Get(':moderatorId/range')
  @RequirePermissions('moderator.performance.view.all')
  @ApiOperation({ summary: "Single moderator's stats range (Manager/Admin)" })
  singleRange(
    @Param('moderatorId', ParseUuidPipe) moderatorId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.service.getRange(moderatorId, from, to);
  }
}
