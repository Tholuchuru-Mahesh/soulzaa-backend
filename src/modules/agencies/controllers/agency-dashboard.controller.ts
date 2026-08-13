import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { RequireRoles } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyGrowthQueryDto } from '../dto/agency-growth-query.dto';
import { AgencyDashboardService } from '../services/agency-dashboard.service';

/**
 * The agency owner's own dashboard.
 *
 * Every query is scoped to the JWT-derived caller id; an `agencyId` is never
 * accepted from the client, in any form. That is what separates this surface
 * from `AgencySettlementController`, where platform staff legitimately pass an
 * agency id — here, accepting one would let any agency read another's
 * community and earnings.
 *
 * `RbacRolesGuard` resolves roles from the `user_roles` RBAC tables, which is
 * where role-request approval writes them. The legacy `User.roles` column is
 * documented as being retired and is deliberately not consulted.
 */
@ApiTags('agency-dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard)
@RequireRoles('AGENCY')
@Controller('agencies/me')
export class AgencyDashboardController {
  constructor(private readonly dashboard: AgencyDashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: "The calling agency's own dashboard" })
  @ApiResponse({ status: 200, description: 'Wallet, community, growth and top performers' })
  getDashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.dashboard.getDashboard(user.id);
  }

  @Get('growth')
  @ApiOperation({ summary: 'Community growth series for the calling agency' })
  @ApiResponse({ status: 200, description: 'Daily member counts across the requested range' })
  getGrowth(@CurrentUser() user: AuthenticatedUser, @Query() query: AgencyGrowthQueryDto) {
    return this.dashboard.getGrowth(user.id, query.range);
  }
}
