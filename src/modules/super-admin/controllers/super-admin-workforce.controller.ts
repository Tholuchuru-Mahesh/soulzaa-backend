import {
  Body,
  Controller,
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
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
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
import {
  AssignWorkforceDto,
  ReassignWorkforceScopeDto,
  TransferWorkforceDto,
} from '../dto/workforce-assignment.dto';
import { WorkforceSearchFilterDto } from '../dto/workforce-query.dto';
import { UpdateWorkforceStatusDto } from '../dto/workforce-status.dto';
import { WorkforceManagementService } from '../services/workforce-management.service';

@ApiTags('Super Admin - Workforce & Personnel Management')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/workforce')
export class SuperAdminWorkforceController {
  constructor(private readonly workforceService: WorkforceManagementService) {}

  // ---------------------------------------------------------
  // Personnel Query & Search APIs
  // ---------------------------------------------------------

  @ApiOperation({
    summary: 'List and search operational workforce personnel (Admin, CM, Official, Moderator, BD)',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of matching workforce personnel' })
  @RequirePermissions('workforce.list.view')
  @Get('personnel')
  async searchWorkforce(@Query() filterDto: WorkforceSearchFilterDto) {
    return this.workforceService.searchWorkforce(filterDto);
  }

  @ApiOperation({ summary: 'Get detailed personnel profile and assigned operational roles/scopes' })
  @ApiResponse({ status: 200, description: 'Personnel profile details' })
  @RequirePermissions('workforce.detail.view')
  @Get('personnel/:id')
  async getWorkforcePersonnelById(@Param('id') id: string) {
    return this.workforceService.getWorkforcePersonnelById(id);
  }

  @ApiOperation({ summary: 'Get workload summary metrics for a personnel member' })
  @ApiResponse({ status: 200, description: 'Personnel workload metrics' })
  @RequirePermissions('workforce.detail.view')
  @Get('personnel/:id/workload')
  async getPersonnelWorkload(@Param('id') id: string) {
    return this.workforceService.getPersonnelWorkload(id);
  }

  @ApiOperation({
    summary: 'Get operational status card (reporting manager, active status, scope details)',
  })
  @ApiResponse({ status: 200, description: 'Personnel operational status card' })
  @RequirePermissions('workforce.detail.view')
  @Get('personnel/:id/status')
  async getOperationalStatus(@Param('id') id: string) {
    return this.workforceService.getOperationalStatus(id);
  }

  // ---------------------------------------------------------
  // Reporting Hierarchy API
  // ---------------------------------------------------------

  @ApiOperation({
    summary:
      'Get full operational reporting hierarchy graph (SUPER_ADMIN -> ADMIN -> CM -> OFFICIAL -> MODERATOR)',
  })
  @ApiResponse({ status: 200, description: 'Operational reporting hierarchy tree' })
  @RequirePermissions('workforce.hierarchy.view')
  @Get('hierarchy')
  async getReportingHierarchy() {
    return this.workforceService.getReportingHierarchy();
  }

  // ---------------------------------------------------------
  // Assignment & Transfer APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Assign operational role and geographic scope to personnel' })
  @ApiResponse({ status: 200, description: 'Workforce assigned successfully' })
  @RequirePermissions('workforce.assign')
  @AuditLogAction('WORKFORCE_ASSIGNED', 'workforce_assignment')
  @Post('assign')
  @HttpCode(HttpStatus.OK)
  async assignWorkforce(@Body() dto: AssignWorkforceDto, @CurrentUser('id') actorId: string) {
    return this.workforceService.assignWorkforce(dto, actorId);
  }

  @ApiOperation({ summary: 'Transfer personnel scope from current geographic unit to target unit' })
  @ApiResponse({ status: 200, description: 'Workforce transferred successfully' })
  @RequirePermissions('workforce.transfer')
  @AuditLogAction('WORKFORCE_TRANSFERRED', 'workforce_assignment')
  @Put('transfer')
  async transferWorkforce(@Body() dto: TransferWorkforceDto, @CurrentUser('id') actorId: string) {
    return this.workforceService.transferWorkforce(dto, actorId);
  }

  @ApiOperation({ summary: 'Reassign operational scope for personnel' })
  @ApiResponse({ status: 200, description: 'Workforce scope reassigned successfully' })
  @RequirePermissions('workforce.transfer')
  @AuditLogAction('WORKFORCE_REASSIGNED', 'workforce_assignment')
  @Put('reassign')
  async reassignScope(@Body() dto: ReassignWorkforceScopeDto, @CurrentUser('id') actorId: string) {
    return this.workforceService.reassignScope(dto, actorId);
  }

  @ApiOperation({ summary: 'Activate or deactivate personnel operational status' })
  @ApiResponse({ status: 200, description: 'Workforce operational status updated' })
  @RequirePermissions('workforce.status.manage')
  @AuditLogAction('WORKFORCE_ACTIVATED', 'workforce_status')
  @Patch('personnel/:id/status')
  async updateOperationalStatus(
    @Param('id') id: string,
    @Body() dto: UpdateWorkforceStatusDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.workforceService.updateOperationalStatus(id, dto, actorId);
  }
}
