import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AssignUserLocationDto } from '../dto/user-location.dto';
import { UserLocationService } from '../services/user-location.service';

/**
 * Assigns users to the geographic hierarchy that scope filtering reads.
 *
 * Assignment is ADMIN-only: an official who could move users between territories
 * could edit their own workload, and could pull an account out of a peer's view.
 * Workforce roles get the read side so their consoles can display a user's
 * territory.
 */
@ApiTags('Organization — User Location')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('organization/users')
export class UserLocationController {
  constructor(private readonly service: UserLocationService) {}

  @ApiOperation({ summary: "Read a user's assigned location" })
  @ApiResponse({ status: 200, description: 'Country, state and region with codes' })
  @RequirePermissions('user.location.view')
  @Get(':userId/location')
  get(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.service.getLocation(userId);
  }

  @ApiOperation({ summary: "Set a user's location" })
  @ApiResponse({ status: 200, description: 'Updated location' })
  @ApiResponse({ status: 400, description: 'Hierarchy is inconsistent' })
  @RequirePermissions('user.location.assign')
  @Put(':userId/location')
  assign(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: AssignUserLocationDto) {
    return this.service.assignLocation(userId, dto);
  }

  @ApiOperation({ summary: 'Backfill countryId from the free-text profile country' })
  @ApiResponse({ status: 200, description: 'Scanned, matched and skipped counts' })
  @RequirePermissions('user.location.assign')
  @Post('location/backfill')
  backfill() {
    return this.service.backfillFromProfileCountry();
  }
}
