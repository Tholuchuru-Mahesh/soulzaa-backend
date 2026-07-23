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
import { SettingSearchFilterDto } from 'src/modules/platform-configuration/dto/setting-query.dto';
import { ToggleFeatureFlagDto } from 'src/modules/platform-configuration/dto/toggle-feature-flag.dto';
import {
  ResetSettingDto,
  UpdateSettingDto,
} from 'src/modules/platform-configuration/dto/update-setting.dto';
import { ConfigurationEngineService } from 'src/modules/platform-configuration/services/configuration-engine.service';
import { ConfigurationHistoryService } from 'src/modules/platform-configuration/services/configuration-history.service';
import { FeatureFlagService } from 'src/modules/platform-configuration/services/feature-flag.service';
import { SettingsQueryService } from 'src/modules/platform-configuration/services/settings-query.service';

@ApiTags('Super Admin - Platform Configuration & Global Settings')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/configuration')
export class SuperAdminConfigurationController {
  constructor(
    private readonly queryService: SettingsQueryService,
    private readonly configEngine: ConfigurationEngineService,
    private readonly featureFlagService: FeatureFlagService,
    private readonly historyService: ConfigurationHistoryService,
  ) {}

  // ---------------------------------------------------------
  // Settings Query & Categories APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Search and filter platform settings' })
  @ApiResponse({ status: 200, description: 'Paginated list of platform settings' })
  @RequirePermissions('config.settings.view')
  @Get('settings')
  async searchSettings(@Query() filterDto: SettingSearchFilterDto) {
    return this.queryService.searchSettings(filterDto);
  }

  @ApiOperation({ summary: 'List all configuration categories with setting counts' })
  @ApiResponse({ status: 200, description: 'Category summary list' })
  @RequirePermissions('config.settings.view')
  @Get('categories')
  async listCategories() {
    return this.queryService.listCategories();
  }

  @ApiOperation({ summary: 'Get single setting details by key' })
  @ApiResponse({ status: 200, description: 'Setting details' })
  @RequirePermissions('config.settings.view')
  @Get('settings/:key')
  async getSettingByKey(@Param('key') key: string) {
    return this.queryService.getSettingByKey(key);
  }

  // ---------------------------------------------------------
  // Setting Modifications & Resets
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Update a platform setting value' })
  @ApiResponse({ status: 200, description: 'Setting value updated successfully' })
  @RequirePermissions('config.settings.update')
  @AuditLogAction('SETTING_UPDATED', 'platform_setting')
  @Put('settings/:key')
  async updateSetting(
    @Param('key') key: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.configEngine.setSetting(key, dto.value, dto.reason, actorId);
  }

  @ApiOperation({ summary: 'Reset a platform setting to its default value' })
  @ApiResponse({ status: 200, description: 'Setting reset to default value' })
  @RequirePermissions('config.settings.reset')
  @AuditLogAction('SETTING_RESET', 'platform_setting')
  @Post('settings/:key/reset')
  @HttpCode(HttpStatus.OK)
  async resetSetting(
    @Param('key') key: string,
    @Body() dto: ResetSettingDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.configEngine.resetSetting(key, dto.reason, actorId);
  }

  // ---------------------------------------------------------
  // Feature Flag APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List all system feature flags' })
  @ApiResponse({ status: 200, description: 'List of feature flags' })
  @RequirePermissions('config.flags.view')
  @Get('feature-flags')
  async listFeatureFlags() {
    return this.featureFlagService.listFeatureFlags();
  }

  @ApiOperation({ summary: 'Enable, disable, or toggle a feature flag' })
  @ApiResponse({ status: 200, description: 'Feature flag status updated' })
  @RequirePermissions('config.flags.manage')
  @AuditLogAction('FEATURE_FLAG_ENABLED', 'feature_flag')
  @Patch('feature-flags/:key/toggle')
  async toggleFeatureFlag(
    @Param('key') key: string,
    @Body() dto: ToggleFeatureFlagDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.featureFlagService.toggleFlag(key, dto.enabled, dto.reason, actorId);
  }

  // ---------------------------------------------------------
  // Setting Change History API
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'View setting change history audit trail' })
  @ApiResponse({ status: 200, description: 'Setting change history logs' })
  @RequirePermissions('config.history.view')
  @Get('settings/:key/history')
  async getSettingHistory(@Param('key') key: string) {
    return this.historyService.getSettingHistory(key);
  }
}
