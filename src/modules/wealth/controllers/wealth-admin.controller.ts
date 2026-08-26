import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { WealthLevel, WealthLevelBenefit } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import {
  CreateWealthBenefitDto,
  CreateWealthRewardDto,
  PaginationQueryDto,
  UpdateWealthBenefitDto,
  UpdateWealthConfigurationDto,
  UpdateWealthDowngradeConfigDto,
  UpdateWealthRewardDto,
  UpsertWealthLevelDto,
} from '../dto/wealth.dto';
import { WealthAdminService } from '../services/wealth-admin.service';
import { WealthDowngradeConfigService } from '../services/wealth-downgrade-config.service';

/**
 * Super Admin Wealth Level management. `wealth.manage` (ADMIN or
 * SUPER_ADMIN) covers levels/benefits/rewards; the downgrade policy and
 * general module configuration require `wealth.level.downgrade.manage` /
 * `wealth.configuration.manage`, which are granted only to SUPER_ADMIN
 * (see rbac-permissions.constants.ts — deliberately absent from ADMIN's
 * permission list, reached only via SUPER_ADMIN's '*' wildcard).
 */
@ApiTags('Wealth Level Admin')
@ApiBearerAuth()
@Controller('admin/wealth')
export class WealthAdminController {
  constructor(
    private readonly admin: WealthAdminService,
    private readonly downgrade: WealthDowngradeConfigService,
    private readonly media: MediaUrlResolver,
  ) {}

  private async resolveLevelIcon(level: WealthLevel): Promise<WealthLevel> {
    return { ...level, iconUrl: await this.media.resolve(level.iconUrl) };
  }

  private async resolveBenefitIcon(benefit: WealthLevelBenefit): Promise<WealthLevelBenefit> {
    return { ...benefit, iconUrl: await this.media.resolve(benefit.iconUrl) };
  }

  @Get('levels')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'List all Wealth Level tiers' })
  async listLevels(): Promise<WealthLevel[]> {
    const levels = await this.admin.listLevels();
    return Promise.all(levels.map((l) => this.resolveLevelIcon(l)));
  }

  @Put('levels')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Create or update a Wealth Level tier' })
  async upsertLevel(
    @CurrentUser('id') actorId: string,
    @Body() dto: UpsertWealthLevelDto,
  ): Promise<WealthLevel> {
    return this.resolveLevelIcon(await this.admin.upsertLevel(actorId, dto.level, dto));
  }

  @Get('benefits')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'List all Wealth Level benefits' })
  async listBenefits(): Promise<WealthLevelBenefit[]> {
    const benefits = await this.admin.listBenefits();
    return Promise.all(benefits.map((b) => this.resolveBenefitIcon(b)));
  }

  @Post('benefits')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Create a Wealth Level benefit' })
  async createBenefit(
    @CurrentUser('id') actorId: string,
    @Body() dto: CreateWealthBenefitDto,
  ): Promise<WealthLevelBenefit> {
    return this.resolveBenefitIcon(await this.admin.createBenefit(actorId, dto));
  }

  @Put('benefits/:id')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Update a Wealth Level benefit' })
  async updateBenefit(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWealthBenefitDto,
  ): Promise<WealthLevelBenefit> {
    return this.resolveBenefitIcon(await this.admin.updateBenefit(actorId, id, dto));
  }

  @Get('rewards')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'List all Wealth Level rewards' })
  listRewards() {
    return this.admin.listRewards();
  }

  @Post('rewards')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Create a Wealth Level reward' })
  createReward(@CurrentUser('id') actorId: string, @Body() dto: CreateWealthRewardDto) {
    return this.admin.createReward(actorId, {
      ...dto,
      startAt: dto.startAt ? new Date(dto.startAt) : null,
      endAt: dto.endAt ? new Date(dto.endAt) : null,
    });
  }

  @Put('rewards/:id')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Update a Wealth Level reward' })
  updateReward(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWealthRewardDto,
  ) {
    return this.admin.updateReward(actorId, id, {
      ...dto,
      startAt: dto.startAt ? new Date(dto.startAt) : undefined,
      endAt: dto.endAt ? new Date(dto.endAt) : undefined,
    });
  }

  @Get('downgrade-config')
  @RequirePermissions('wealth.level.downgrade.manage')
  @ApiOperation({ summary: 'Get the active downgrade policy (SUPER_ADMIN only)' })
  getDowngradeConfig() {
    return this.downgrade.list();
  }

  @Put('downgrade-config')
  @RequirePermissions('wealth.level.downgrade.manage')
  @ApiOperation({ summary: 'Update the monthly downgrade policy (SUPER_ADMIN only)' })
  updateDowngradeConfig(
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateWealthDowngradeConfigDto,
  ) {
    return this.downgrade.update(actorId, {
      enabled: dto.enabled,
      maxDowngradeLevels: dto.maxDowngradeLevels,
      minLevel: dto.minLevel,
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
    });
  }

  @Get('configuration')
  @RequirePermissions('wealth.configuration.manage')
  @ApiOperation({ summary: 'Get general Wealth Level configuration (SUPER_ADMIN only)' })
  getConfiguration() {
    return this.admin.getConfiguration();
  }

  @Put('configuration')
  @RequirePermissions('wealth.configuration.manage')
  @ApiOperation({ summary: 'Update general Wealth Level configuration (SUPER_ADMIN only)' })
  updateConfiguration(
    @CurrentUser('id') actorId: string,
    @Body() dto: UpdateWealthConfigurationDto,
  ) {
    return this.admin.updateConfiguration(actorId, dto.key, dto.value);
  }

  @Get('audit')
  @RequirePermissions('wealth.audit.view')
  @ApiOperation({ summary: 'Get Wealth Level configuration audit history' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.admin.listAudit(q.page ?? 1, q.limit ?? 20);
  }
}
