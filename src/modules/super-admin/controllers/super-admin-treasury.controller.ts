import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { EmergencyFreezeDto } from 'src/modules/treasury/dto/emergency-freeze.dto';
import { TreasuryAuditFilterDto } from 'src/modules/treasury/dto/treasury-query.dto';
import { UpdateFinancialPolicyDto } from 'src/modules/treasury/dto/update-policy.dto';
import { CoinEconomyService } from 'src/modules/treasury/services/coin-economy.service';
import { FinancialHealthService } from 'src/modules/treasury/services/financial-health.service';
import { FinancialPolicyService } from 'src/modules/treasury/services/financial-policy.service';
import { RiskManagementService } from 'src/modules/treasury/services/risk-management.service';
import { TreasuryAuditService } from 'src/modules/treasury/services/treasury-audit.service';
import { TreasuryService } from 'src/modules/treasury/services/treasury.service';

@ApiTags('Super Admin - Treasury & Coin Economy Governance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/treasury')
export class SuperAdminTreasuryController {
  constructor(
    private readonly treasuryService: TreasuryService,
    private readonly economyService: CoinEconomyService,
    private readonly healthService: FinancialHealthService,
    private readonly policyService: FinancialPolicyService,
    private readonly riskService: RiskManagementService,
    private readonly auditService: TreasuryAuditService,
  ) {}

  // ---------------------------------------------------------
  // Treasury & Economy Metrics APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get global treasury reserve balance and coin supply summary' })
  @ApiResponse({ status: 200, description: 'Treasury summary metrics' })
  @RequirePermissions('treasury.summary.view')
  @Get('summary')
  async getTreasurySummary() {
    return this.treasuryService.getTreasurySummary();
  }

  @ApiOperation({ summary: 'Get coin economy governance state (circulating, reserved, mintable)' })
  @ApiResponse({ status: 200, description: 'Coin economy governance state' })
  @RequirePermissions('treasury.economy.view')
  @Get('coin-economy')
  async getCoinEconomyState() {
    return this.economyService.getCoinEconomyState();
  }

  @ApiOperation({ summary: 'Get financial health metrics, reserve ratio percentage, and alerts' })
  @ApiResponse({ status: 200, description: 'Financial health assessment' })
  @RequirePermissions('treasury.health.view')
  @Get('health')
  async getFinancialHealth() {
    return this.healthService.getFinancialHealth();
  }

  // ---------------------------------------------------------
  // Financial Policy Limits APIs
  // ---------------------------------------------------------

  @ApiOperation({
    summary:
      'List all platform financial policy limits (daily wallet bounds, gift caps, withdrawal bounds)',
  })
  @ApiResponse({ status: 200, description: 'List of financial policies' })
  @RequirePermissions('treasury.policies.view')
  @Get('policies')
  async listPolicies() {
    return this.policyService.listPolicies();
  }

  @ApiOperation({ summary: 'Update a financial policy limit cap' })
  @ApiResponse({ status: 200, description: 'Policy limit updated successfully' })
  @RequirePermissions('treasury.policies.update')
  @AuditLogAction('FINANCIAL_LIMIT_UPDATED', 'financial_policy')
  @Put('policies/:key')
  async updatePolicy(
    @Param('key') key: string,
    @Body() dto: UpdateFinancialPolicyDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.policyService.updatePolicy(key, dto.value, dto.reason, actorId);
  }

  // ---------------------------------------------------------
  // Risk Control & Emergency Freeze APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get risk control flags and emergency lock status' })
  @ApiResponse({ status: 200, description: 'Risk control status' })
  @RequirePermissions('treasury.risk.view')
  @Get('risk-controls')
  async getRiskControlsStatus() {
    return this.riskService.getRiskControlsStatus();
  }

  @ApiOperation({
    summary: 'Trigger Emergency Freeze across economy or specific financial feature',
  })
  @ApiResponse({ status: 200, description: 'Emergency freeze applied successfully' })
  @RequirePermissions('treasury.risk.manage')
  @AuditLogAction('ECONOMY_FROZEN', 'treasury_risk')
  @Post('risk/freeze')
  @HttpCode(HttpStatus.OK)
  async freezeEconomy(@Body() dto: EmergencyFreezeDto, @CurrentUser('id') actorId: string) {
    return this.riskService.freezeEconomy(dto.scope, dto.reason, actorId);
  }

  @ApiOperation({ summary: 'Resume economy operations from emergency freeze' })
  @ApiResponse({ status: 200, description: 'Economy operations resumed successfully' })
  @RequirePermissions('treasury.risk.manage')
  @AuditLogAction('ECONOMY_RESUMED', 'treasury_risk')
  @Post('risk/resume')
  @HttpCode(HttpStatus.OK)
  async resumeEconomy(@Body() dto: EmergencyFreezeDto, @CurrentUser('id') actorId: string) {
    return this.riskService.resumeEconomy(dto.scope, dto.reason, actorId);
  }

  // ---------------------------------------------------------
  // Treasury Audit Logs API
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'View treasury audit log history' })
  @ApiResponse({ status: 200, description: 'Treasury operational logs' })
  @RequirePermissions('treasury.audit.view')
  @Get('audit-logs')
  async getAuditHistory(@Query() filterDto: TreasuryAuditFilterDto) {
    return this.auditService.getAuditHistory(filterDto.operation, filterDto.page, filterDto.limit);
  }
}
