import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { GeographyOptionDto } from '../dto/geography-lookup.dto';
import { CountryService } from '../services/country.service';
import { OrganizationHierarchyService } from '../services/organization-hierarchy.service';
import { RegionService } from '../services/region.service';
import { StateService } from '../services/state.service';

/** Country/State/Region rows share the selector shape; map once. */
const toOption = (row: {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}): GeographyOptionDto => ({
  id: row.id,
  code: row.code,
  name: row.name,
  isActive: row.isActive,
});

/**
 * Read-only geography lookups for cascading selectors in the admin consoles.
 *
 * Gated on `organization.hierarchy.view`, which ADMIN already holds. Creating
 * and deactivating geography stays on the SUPER_ADMIN CRUD routes — splitting
 * read from write is what lets ADMIN assign a user's location without also being
 * able to deactivate a country and change what every operator beneath it sees.
 */
@ApiTags('Organization — Geography Lookup')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('organization/geography')
export class GeographyLookupController {
  constructor(
    private readonly countries: CountryService,
    private readonly states: StateService,
    private readonly regions: RegionService,
    private readonly hierarchy: OrganizationHierarchyService,
  ) {}

  @ApiOperation({ summary: 'List countries for a selector' })
  @ApiQuery({ name: 'activeOnly', required: false, description: 'Default true' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  // Any signed-in user: these are the options an agency applicant picks from,
  // and a list of country names reveals nothing.
  @Get('countries')
  async listCountries(@Query('activeOnly') activeOnly?: string) {
    const rows = await this.countries.getAllCountries(activeOnly !== 'false');
    return rows.map(toOption);
  }

  @ApiOperation({ summary: 'List the states of a country' })
  @ApiQuery({ name: 'activeOnly', required: false, description: 'Default true' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  // Selector data, same reasoning as the country list.
  @Get('countries/:countryId/states')
  async listStates(
    @Param('countryId') countryId: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const rows = await this.states.getAllStates(countryId, activeOnly !== 'false');
    return rows.map(toOption);
  }

  @ApiOperation({ summary: 'List the regions of a state' })
  @ApiQuery({ name: 'activeOnly', required: false, description: 'Default true' })
  @ApiResponse({ status: 200, type: [GeographyOptionDto] })
  // Selector data, same reasoning as the country list.
  @Get('states/:stateId/regions')
  async listRegions(@Param('stateId') stateId: string, @Query('activeOnly') activeOnly?: string) {
    const rows = await this.regions.getAllRegions(stateId, activeOnly !== 'false');
    return rows.map(toOption);
  }

  @ApiOperation({ summary: 'Full Country → State → Region tree' })
  // Still gated: the whole hierarchy at once is an operational view rather
  // than something a form needs.
  @RequirePermissions('organization.hierarchy.view')
  @ApiResponse({ status: 200, description: 'Nested hierarchy for tree views' })
  @Get('tree')
  tree() {
    return this.hierarchy.getFullHierarchy();
  }
}
