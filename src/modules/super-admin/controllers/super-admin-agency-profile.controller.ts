import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AgencyActivityQueryDto } from '../dto/agency-profile.dto';
import { AgencyProfileService } from '../services/agency-profile.service';

/**
 * Super Admin drill-down for one agency / coin seller account.
 *
 * Read-only by design: balance corrections and sale reversals stay in the
 * wallet and coin-seller modules that own those invariants, so nothing here
 * can move coins.
 */
@ApiTags('Super Admin - Agency & Coin Seller Profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@Controller('super-admin/agencies')
export class SuperAdminAgencyProfileController {
  constructor(private readonly agencyProfile: AgencyProfileService) {}

  @ApiOperation({
    summary:
      'Full agency profile: identity, coin seller inventory, personal wallet, settlement earnings and member counts',
  })
  @ApiResponse({ status: 200, description: 'Agency profile overview' })
  @ApiResponse({ status: 404, description: 'No user matches this agency id' })
  @RequirePermissions('user.profile.view')
  @Get(':agencyId/overview')
  getOverview(@Param('agencyId', ParseUUIDPipe) agencyId: string) {
    return this.agencyProfile.getOverview(agencyId);
  }

  @ApiOperation({
    summary:
      'Paged agency ledger — coin sales to users (who received coins), inventory purchases, wallet ledger, settlements or distributed rewards',
  })
  @ApiResponse({ status: 200, description: 'Paginated activity rows for the requested ledger' })
  @RequirePermissions('user.profile.view')
  @Get(':agencyId/activity')
  getActivity(
    @Param('agencyId', ParseUUIDPipe) agencyId: string,
    @Query() query: AgencyActivityQueryDto,
  ) {
    return this.agencyProfile.getActivity(agencyId, query.type, query.page, query.limit);
  }
}
