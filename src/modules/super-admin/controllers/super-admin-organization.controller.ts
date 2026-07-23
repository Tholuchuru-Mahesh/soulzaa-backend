import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { CreateCountryDto, UpdateCountryDto } from 'src/modules/organization/dto/country.dto';
import { CreateRegionDto, UpdateRegionDto } from 'src/modules/organization/dto/region.dto';
import { CreateStateDto, UpdateStateDto } from 'src/modules/organization/dto/state.dto';
import { UpdateStatusDto } from 'src/modules/organization/dto/status-update.dto';
import { CountryService } from 'src/modules/organization/services/country.service';
import { OrganizationHierarchyService } from 'src/modules/organization/services/organization-hierarchy.service';
import { RegionService } from 'src/modules/organization/services/region.service';
import { StateService } from 'src/modules/organization/services/state.service';
import { AssignCountryManagerDto, TransferCountryManagerDto } from '../dto/country-manager.dto';
import { CountryManagerAssignmentService } from '../services/country-manager-assignment.service';

@ApiTags('Super Admin - Organization')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/organization')
export class SuperAdminOrganizationController {
  constructor(
    private readonly countryService: CountryService,
    private readonly stateService: StateService,
    private readonly regionService: RegionService,
    private readonly hierarchyService: OrganizationHierarchyService,
    private readonly managerService: CountryManagerAssignmentService,
  ) {}

  // ---------------------------------------------------------
  // Country Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Create a new country' })
  @ApiResponse({ status: 201, description: 'Country created successfully' })
  @RequirePermissions('organization.country.manage')
  @AuditLogAction('COUNTRY_CREATED', 'country')
  @Post('countries')
  async createCountry(@Body() dto: CreateCountryDto) {
    return this.countryService.createCountry(dto);
  }

  @ApiOperation({ summary: 'List all countries' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'List of countries' })
  @Get('countries')
  async getAllCountries(@Query('activeOnly') activeOnly?: boolean) {
    return this.countryService.getAllCountries(activeOnly);
  }

  @ApiOperation({ summary: 'Get country by ID' })
  @ApiResponse({ status: 200, description: 'Country details' })
  @Get('countries/:id')
  async getCountryById(@Param('id') id: string) {
    return this.countryService.getCountryById(id);
  }

  @ApiOperation({ summary: 'Update country details' })
  @ApiResponse({ status: 200, description: 'Country updated successfully' })
  @RequirePermissions('organization.country.manage')
  @AuditLogAction('COUNTRY_UPDATED', 'country')
  @Put('countries/:id')
  async updateCountry(@Param('id') id: string, @Body() dto: UpdateCountryDto) {
    return this.countryService.updateCountry(id, dto);
  }

  @ApiOperation({ summary: 'Activate or deactivate a country' })
  @ApiResponse({ status: 200, description: 'Country status updated' })
  @RequirePermissions('organization.country.manage')
  @AuditLogAction('COUNTRY_STATUS_CHANGED', 'country')
  @Patch('countries/:id/status')
  async setCountryStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.countryService.setCountryStatus(id, dto.isActive);
  }

  // ---------------------------------------------------------
  // State Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Create a new state under a country' })
  @ApiResponse({ status: 201, description: 'State created successfully' })
  @RequirePermissions('organization.state.manage')
  @AuditLogAction('STATE_CREATED', 'state')
  @Post('states')
  async createState(@Body() dto: CreateStateDto) {
    return this.stateService.createState(dto);
  }

  @ApiOperation({ summary: 'List all states' })
  @ApiQuery({ name: 'countryId', required: false })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'List of states' })
  @Get('states')
  async getAllStates(
    @Query('countryId') countryId?: string,
    @Query('activeOnly') activeOnly?: boolean,
  ) {
    return this.stateService.getAllStates(countryId, activeOnly);
  }

  @ApiOperation({ summary: 'Get state by ID' })
  @ApiResponse({ status: 200, description: 'State details' })
  @Get('states/:id')
  async getStateById(@Param('id') id: string) {
    return this.stateService.getStateById(id);
  }

  @ApiOperation({ summary: 'Update state details' })
  @ApiResponse({ status: 200, description: 'State updated successfully' })
  @RequirePermissions('organization.state.manage')
  @AuditLogAction('STATE_UPDATED', 'state')
  @Put('states/:id')
  async updateState(@Param('id') id: string, @Body() dto: UpdateStateDto) {
    return this.stateService.updateState(id, dto);
  }

  @ApiOperation({ summary: 'Activate or deactivate a state' })
  @ApiResponse({ status: 200, description: 'State status updated' })
  @RequirePermissions('organization.state.manage')
  @AuditLogAction('STATE_STATUS_CHANGED', 'state')
  @Patch('states/:id/status')
  async setStateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.stateService.setStateStatus(id, dto.isActive);
  }

  // ---------------------------------------------------------
  // Region Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Create a new region under a state' })
  @ApiResponse({ status: 201, description: 'Region created successfully' })
  @RequirePermissions('organization.region.manage')
  @AuditLogAction('REGION_CREATED', 'region')
  @Post('regions')
  async createRegion(@Body() dto: CreateRegionDto) {
    return this.regionService.createRegion(dto);
  }

  @ApiOperation({ summary: 'List all regions' })
  @ApiQuery({ name: 'stateId', required: false })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'List of regions' })
  @Get('regions')
  async getAllRegions(
    @Query('stateId') stateId?: string,
    @Query('activeOnly') activeOnly?: boolean,
  ) {
    return this.regionService.getAllRegions(stateId, activeOnly);
  }

  @ApiOperation({ summary: 'Get region by ID' })
  @ApiResponse({ status: 200, description: 'Region details' })
  @Get('regions/:id')
  async getRegionById(@Param('id') id: string) {
    return this.regionService.getRegionById(id);
  }

  @ApiOperation({ summary: 'Update region details' })
  @ApiResponse({ status: 200, description: 'Region updated successfully' })
  @RequirePermissions('organization.region.manage')
  @AuditLogAction('REGION_UPDATED', 'region')
  @Put('regions/:id')
  async updateRegion(@Param('id') id: string, @Body() dto: UpdateRegionDto) {
    return this.regionService.updateRegion(id, dto);
  }

  @ApiOperation({ summary: 'Activate or deactivate a region' })
  @ApiResponse({ status: 200, description: 'Region status updated' })
  @RequirePermissions('organization.region.manage')
  @AuditLogAction('REGION_STATUS_CHANGED', 'region')
  @Patch('regions/:id/status')
  async setRegionStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.regionService.setRegionStatus(id, dto.isActive);
  }

  // ---------------------------------------------------------
  // Organizational Hierarchy API
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get complete data-driven organizational hierarchy graph' })
  @ApiResponse({
    status: 200,
    description: 'Full organizational hierarchy tree (Country -> State -> Region)',
  })
  @RequirePermissions('organization.hierarchy.view')
  @Get('hierarchy')
  async getFullHierarchy() {
    return this.hierarchyService.getFullHierarchy();
  }

  // ---------------------------------------------------------
  // Country Manager Assignment APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Assign a Country Manager to a country' })
  @ApiResponse({ status: 200, description: 'Country Manager assigned successfully' })
  @RequirePermissions('organization.manager.assign')
  @AuditLogAction('COUNTRY_MANAGER_ASSIGNED', 'country_manager')
  @Post('countries/:countryId/managers')
  @HttpCode(HttpStatus.OK)
  async assignCountryManager(
    @Param('countryId') countryId: string,
    @Body() dto: AssignCountryManagerDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.managerService.assignCountryManager(countryId, dto.userId, actorId);
  }

  @ApiOperation({ summary: 'Transfer a Country Manager to another country' })
  @ApiResponse({ status: 200, description: 'Country Manager transferred successfully' })
  @RequirePermissions('organization.manager.assign')
  @AuditLogAction('COUNTRY_MANAGER_TRANSFERRED', 'country_manager')
  @Put('countries/:countryId/managers/transfer')
  async transferCountryManager(
    @Param('countryId') countryId: string,
    @Body() dto: TransferCountryManagerDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.managerService.transferCountryManager(
      countryId,
      dto.userId,
      dto.targetCountryId,
      actorId,
    );
  }

  @ApiOperation({ summary: 'Remove a Country Manager from a country' })
  @ApiResponse({ status: 200, description: 'Country Manager removed successfully' })
  @RequirePermissions('organization.manager.assign')
  @AuditLogAction('COUNTRY_MANAGER_REMOVED', 'country_manager')
  @Delete('countries/:countryId/managers/:userId')
  async removeCountryManager(
    @Param('countryId') countryId: string,
    @Param('userId') userId: string,
  ) {
    return this.managerService.removeCountryManager(countryId, userId);
  }
}
