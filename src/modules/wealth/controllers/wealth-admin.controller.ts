import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { WealthBenefitCategory, WealthLevel, WealthLevelBenefit } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import {
  CreateWealthBenefitCategoryDto,
  CreateWealthBenefitDto,
  PaginationQueryDto,
  UpdateWealthBenefitCategoryDto,
  UpdateWealthBenefitDto,
  UpdateWealthConfigurationDto,
  UpdateWealthDowngradeConfigDto,
  UpsertWealthLevelDto,
} from '../dto/wealth.dto';
import { WealthAdminService } from '../services/wealth-admin.service';
import { WealthDowngradeConfigService } from '../services/wealth-downgrade-config.service';

/**
 * Super Admin Wealth Level management. `wealth.manage` (ADMIN or
 * SUPER_ADMIN) covers levels/benefits; the downgrade policy and
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
    return {
      ...level,
      iconUrl: await this.media.resolve(level.iconUrl),
      backgroundUrl: await this.media.resolve(level.backgroundUrl),
    };
  }

  private async resolveBenefitIcon(benefit: WealthLevelBenefit): Promise<WealthLevelBenefit> {
    return { ...benefit, iconUrl: await this.media.resolve(benefit.iconUrl) };
  }

  private async resolveCategoryIcon(category: WealthBenefitCategory): Promise<WealthBenefitCategory> {
    return { ...category, iconUrl: await this.media.resolve(category.iconUrl) };
  }

  @Get('levels')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'List all Wealth Level tiers (including inactive)' })
  async listLevels(): Promise<WealthLevel[]> {
    const levels = await this.admin.listLevels();
    return Promise.all(levels.map((l) => this.resolveLevelIcon(l)));
  }

  @Get('levels/next-ordinal')
  @RequirePermissions('wealth.manage')
  @ApiOperation({
    summary: 'The next free tier ordinal for "+ Add level" — the client never assigns this itself.',
  })
  async nextLevelOrdinal(): Promise<{ level: number }> {
    return { level: await this.admin.nextLevelOrdinal() };
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

  @Get('benefit-categories')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'List all Wealth Level benefit categories (including inactive)' })
  async listCategories(): Promise<WealthBenefitCategory[]> {
    const categories = await this.admin.listCategories();
    return Promise.all(categories.map((c) => this.resolveCategoryIcon(c)));
  }

  @Post('benefit-categories')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Create a Wealth Level benefit category (a display tile grouping multiple rewards)' })
  async createCategory(
    @CurrentUser('id') actorId: string,
    @Body() dto: CreateWealthBenefitCategoryDto,
  ): Promise<WealthBenefitCategory> {
    return this.resolveCategoryIcon(await this.admin.createCategory(actorId, dto));
  }

  @Put('benefit-categories/:id')
  @RequirePermissions('wealth.manage')
  @ApiOperation({ summary: 'Update a Wealth Level benefit category' })
  async updateCategory(
    @CurrentUser('id') actorId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWealthBenefitCategoryDto,
  ): Promise<WealthBenefitCategory> {
    return this.resolveCategoryIcon(await this.admin.updateCategory(actorId, id, dto));
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
