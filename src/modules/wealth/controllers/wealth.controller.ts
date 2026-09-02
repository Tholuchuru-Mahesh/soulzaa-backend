import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { WealthBenefitCategory, WealthLevel } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { WealthBenefitService, type WealthBenefitView } from '../services/wealth-benefit.service';
import { WealthLevelService } from '../services/wealth-level.service';
import { WealthProgressService } from '../services/wealth-progress.service';

/**
 * User-facing Wealth Level API. Every value returned is backend-computed —
 * level, EXP, progress, and benefit eligibility are never accepted from the
 * client (see WealthExpLedgerService: EXP only ever moves via the verified
 * Gold Coin purchase listener).
 */
@ApiTags('Wealth Level')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('wealth')
export class WealthController {
  constructor(
    private readonly progress: WealthProgressService,
    private readonly levels: WealthLevelService,
    private readonly benefits: WealthBenefitService,
    private readonly media: MediaUrlResolver,
  ) {}

  /** Resolves Super-Admin-uploaded icon/background keys to servable URLs, in place. */
  private async resolveLevelIcon(level: WealthLevel): Promise<WealthLevel> {
    return {
      ...level,
      iconUrl: await this.media.resolve(level.iconUrl),
      backgroundUrl: await this.media.resolve(level.backgroundUrl),
    };
  }

  private resolveLevelIcons(levels: WealthLevel[]): Promise<WealthLevel[]> {
    return Promise.all(levels.map((l) => this.resolveLevelIcon(l)));
  }

  private async resolveCategoryIcon(category: WealthBenefitCategory): Promise<WealthBenefitCategory> {
    return { ...category, iconUrl: await this.media.resolve(category.iconUrl) };
  }

  private async resolveBenefitIcon(benefit: WealthBenefitView): Promise<WealthBenefitView> {
    const iconUrl = await this.media.resolve(benefit.iconUrl);
    const cosmetic = benefit.cosmetic
      ? {
          ...benefit.cosmetic,
          mediaUrl: await this.media.resolve(benefit.cosmetic.mediaUrl),
          thumbnailUrl: await this.media.resolve(benefit.cosmetic.thumbnailUrl),
        }
      : null;
    const config =
      typeof benefit.config === 'object' && benefit.config !== null
        ? {
            ...benefit.config,
            mediaUrl: await this.media.resolve((benefit.config as any).mediaUrl),
            thumbnailUrl: await this.media.resolve((benefit.config as any).thumbnailUrl),
          }
        : benefit.config;

    return {
      ...benefit,
      iconUrl: iconUrl || cosmetic?.thumbnailUrl || cosmetic?.mediaUrl || null,
      cosmetic,
      config,
    };
  }

  private resolveBenefitIcons(benefits: WealthBenefitView[]): Promise<WealthBenefitView[]> {
    return Promise.all(benefits.map((b) => this.resolveBenefitIcon(b)));
  }

  @Get('me')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Get current user Wealth Level status for this month' })
  @ApiResponse({ status: 200, description: 'Current level, EXP, and progress to next level' })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.progress.getStatus(user.id);
  }

  @Get('users/:userId')
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary: "Get another user's Wealth Level status for this month (in-room badges, PK panels)",
  })
  getUserStatus(@Param('userId') userId: string) {
    return this.progress.getStatus(userId);
  }

  @Get('levels')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'List all Wealth Level tiers' })
  listLevels(): Promise<WealthLevel[]> {
    return this.resolveLevelIcons(this.levels.list());
  }

  @Get('levels/:level')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Get one Wealth Level tier by ordinal' })
  async getLevel(@Param('level', ParseIntPipe) level: number): Promise<WealthLevel | null> {
    const found = this.levels.getByOrdinal(level);
    return found ? this.resolveLevelIcon(found) : null;
  }

  @Get('levels/:level/benefits')
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary: 'Cumulative benefits at a given level (0..level), for the All Levels detail view',
  })
  async getLevelBenefits(
    @Param('level', ParseIntPipe) level: number,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<WealthBenefitView[]> {
    return this.resolveBenefitIcons(await this.benefits.getBenefitsUpToLevel(level, user.id));
  }

  @Get('benefits')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Get current user cumulative Wealth Level benefits' })
  async getBenefits(@CurrentUser() user: AuthenticatedUser): Promise<WealthBenefitView[]> {
    const status = await this.progress.getStatus(user.id);
    return this.resolveBenefitIcons(
      await this.benefits.getBenefitsUpToLevel(status.level, user.id),
    );
  }

  @Get('benefit-categories')
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary:
      'Active benefit category tiles (e.g. Frames, Entry Effects) across every level — group ' +
      'benefits client-side by matching `categoryId`. Fetch once alongside levels/benefits, ' +
      'never per-tap.',
  })
  async getCategories(): Promise<WealthBenefitCategory[]> {
    const categories = await this.benefits.getCategories();
    return Promise.all(categories.map((c) => this.resolveCategoryIcon(c)));
  }

  @Post('benefits/:id/claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary:
      'Claim a grantable benefit (frame/room theme/entrance effect/badge/gold coins) into the ' +
      "backpack. Requires the user's level to meet the benefit's level.",
  })
  async claimBenefit(@CurrentUser() user: AuthenticatedUser, @Param('id') benefitId: string) {
    const status = await this.progress.getStatus(user.id);
    return this.benefits.claimBenefit(user.id, benefitId, status.level);
  }

  @Post('benefits/:id/equip')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary:
      'Equip a claimed display benefit (badge/frame/theme/entrance effect). The benefit must ' +
      'already be claimed (POST benefits/:id/claim) if it is a grantable type.',
  })
  async equipBenefit(@CurrentUser() user: AuthenticatedUser, @Param('id') benefitId: string) {
    const status = await this.progress.getStatus(user.id);
    await this.benefits.equipBenefit(user.id, benefitId, status.level);
    return { equipped: true };
  }

  @Post('benefits/:id/unequip')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Unequip a display benefit.' })
  async unequipBenefit(@CurrentUser() user: AuthenticatedUser, @Param('id') benefitId: string) {
    const status = await this.progress.getStatus(user.id);
    await this.benefits.unequipBenefit(user.id, benefitId, status.level);
    return { equipped: false };
  }
}
