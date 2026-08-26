import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { WealthLevel } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { PaginationQueryDto } from '../dto/wealth.dto';
import { WealthBenefitService, type WealthBenefitView } from '../services/wealth-benefit.service';
import { WealthLevelService } from '../services/wealth-level.service';
import { WealthProgressService } from '../services/wealth-progress.service';
import { WealthRewardService } from '../services/wealth-reward.service';

/**
 * User-facing Wealth Level API. Every value returned is backend-computed —
 * level, EXP, progress, benefits, and reward eligibility are never accepted
 * from the client (see WealthExpLedgerService: EXP only ever moves via the
 * verified Gold Coin purchase listener).
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
    private readonly rewards: WealthRewardService,
    private readonly media: MediaUrlResolver,
  ) {}

  /** Resolves a Super-Admin-uploaded icon key to a servable URL, in place. */
  private async resolveLevelIcon(level: WealthLevel): Promise<WealthLevel> {
    return { ...level, iconUrl: await this.media.resolve(level.iconUrl) };
  }

  private resolveLevelIcons(levels: WealthLevel[]): Promise<WealthLevel[]> {
    return Promise.all(levels.map((l) => this.resolveLevelIcon(l)));
  }

  private async resolveBenefitIcon(benefit: WealthBenefitView): Promise<WealthBenefitView> {
    return { ...benefit, iconUrl: await this.media.resolve(benefit.iconUrl) };
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

  @Get('levels/:level/rewards')
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary: 'Rewards available at a given level (0..level), for the All Levels detail view',
  })
  getLevelRewards(@Param('level', ParseIntPipe) level: number) {
    return this.rewards.listAvailableForLevel(level);
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

  @Post('benefits/:id/equip')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('wealth.view')
  @ApiOperation({
    summary:
      'Equip an unlocked display benefit (badge/frame/ring/theme). Grants the underlying ' +
      "cosmetic into the user's inventory first if needed (idempotent), then equips it.",
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

  @Get('rewards')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Get rewards available to the current user (up to their level)' })
  async getAvailableRewards(@CurrentUser() user: AuthenticatedUser) {
    const status = await this.progress.getStatus(user.id);
    return this.rewards.listAvailableForLevel(status.level);
  }

  @Post('rewards/:id/claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Claim a claimable Wealth Level reward' })
  async claimReward(@CurrentUser() user: AuthenticatedUser, @Param('id') rewardId: string) {
    const status = await this.progress.getStatus(user.id);
    return this.rewards.claimReward(user.id, rewardId, status.level);
  }

  @Get('rewards/claims')
  @RequirePermissions('wealth.view')
  @ApiOperation({ summary: 'Paginated reward claim history for the current user' })
  getClaimHistory(@CurrentUser() user: AuthenticatedUser, @Query() q: PaginationQueryDto) {
    return this.rewards.listClaims(user.id, q.page ?? 1, q.limit ?? 20);
  }
}
