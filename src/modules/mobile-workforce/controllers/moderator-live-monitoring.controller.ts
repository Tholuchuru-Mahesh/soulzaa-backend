import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import type { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { MobileWorkforceService } from '../services/mobile-workforce.service';

/**
 * Task 22 — Region-Scoped Live Monitoring endpoint.
 * Returns active audio rooms, video rooms, and live streams counts + lists
 * scoped by the moderator's assigned region. Delegates to
 * `MobileWorkforceService.liveMonitoring` — the same query also backs the
 * `liveMonitoring` field on the moderator dashboard, so both surfaces agree.
 */
@ApiTags('Moderation - Live Monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('moderation/live-monitoring')
export class ModeratorLiveMonitoringController {
  constructor(private readonly workforce: MobileWorkforceService) {}

  @Get()
  @RequirePermissions('mobile.workforce.view')
  @ApiOperation({
    summary: 'Region-scoped live monitoring: active rooms and streams for the assigned region',
  })
  async getLiveMonitoring(@CurrentUser() user: AuthenticatedUser) {
    return this.workforce.liveMonitoring(user.id);
  }
}
