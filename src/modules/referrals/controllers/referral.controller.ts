import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';

import { ReferralService } from '../services/referral.service';
import { ReferralCodeService } from '../services/referral-code.service';
import { ReferralCampaignService } from '../services/referral-campaign.service';
import { ReferralRewardService } from '../services/referral-reward.service';
import { ReferralQualificationService } from '../services/referral-qualification.service';
import { ReferralStatisticsService } from '../services/referral-statistics.service';
import { ReferralAuditService } from '../services/referral-audit.service';
import { ReferralConfigurationService } from '../services/referral-configuration.service';
import { ReferralQueryService } from '../services/referral-query.service';
import {
  RegisterReferralDto,
  QualifyReferralDto,
  CancelReferralDto,
  CreateReferralCodeDto,
  CreateCampaignDto,
  DispatchRewardDto,
  UpdateConfigDto,
} from '../dto/referral.dto';

@ApiTags('Referrals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('referrals')
export class ReferralController {
  constructor(
    private readonly referralService: ReferralService,
    private readonly codeService: ReferralCodeService,
    private readonly campaignService: ReferralCampaignService,
    private readonly rewardService: ReferralRewardService,
    private readonly qualificationService: ReferralQualificationService,
    private readonly statisticsService: ReferralStatisticsService,
    private readonly auditService: ReferralAuditService,
    private readonly configService: ReferralConfigurationService,
    private readonly queryService: ReferralQueryService,
  ) {}

  // ── Referral Code Endpoints ───────────────────────────────────────
  @Post('codes')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Generate a new referral code for a user' })
  @ApiResponse({ status: 201, description: 'Referral code created.' })
  async createCode(@Body() dto: CreateReferralCodeDto) {
    return this.codeService.createCode({
      referrerId: dto.referrerId,
      campaignId: dto.campaignId,
      maxUses: dto.maxUses,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  @Get('codes/referrer/:referrerId')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get all active referral codes for a user' })
  async getCodesByReferrer(@Param('referrerId', ParseUUIDPipe) referrerId: string) {
    return this.codeService.findByReferrer(referrerId);
  }

  @Get('codes/:code')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Lookup a referral code' })
  async getCode(@Param('code') code: string) {
    return this.codeService.findByCode(code);
  }

  // ── Referral Relationship Endpoints ──────────────────────────────
  @Post('register')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Register a referee using a referral code' })
  @ApiResponse({ status: 201, description: 'Referral relationship created.' })
  async register(@Body() dto: RegisterReferralDto) {
    return this.referralService.register(dto);
  }

  @Post('qualify')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Qualify a referral relationship' })
  async qualify(@Body() dto: QualifyReferralDto) {
    return this.referralService.qualify(dto);
  }

  @Patch('cancel')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Cancel a referral relationship' })
  async cancel(@Body() dto: CancelReferralDto) {
    return this.referralService.cancel(dto.relationshipId, dto.actorId);
  }

  @Get(':id')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get referral relationship by ID' })
  async getRelationship(@Param('id', ParseUUIDPipe) id: string) {
    return this.referralService.findById(id);
  }

  @Get('referee/:refereeId')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get the referral record for a referee user' })
  async getByReferee(@Param('refereeId', ParseUUIDPipe) refereeId: string) {
    return this.referralService.findByReferee(refereeId);
  }

  @Get('referrer/:referrerId/list')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get all referrals made by a referrer' })
  async getByReferrer(@Param('referrerId', ParseUUIDPipe) referrerId: string) {
    return this.referralService.findByReferrer(referrerId);
  }

  // ── Qualification Endpoints ───────────────────────────────────────
  @Get(':id/qualification')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get qualification status of a referral relationship' })
  async getQualification(@Param('id', ParseUUIDPipe) id: string) {
    return this.qualificationService.getQualificationStatus(id);
  }

  // ── Reward Endpoints ──────────────────────────────────────────────
  @Post('rewards/dispatch')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Dispatch a referral reward via domain event' })
  async dispatchReward(@Body() dto: DispatchRewardDto) {
    return this.rewardService.dispatch({
      relationshipId: dto.relationshipId,
      referrerId: dto.referrerId,
      refereeId: dto.refereeId,
      rewardDefinition: dto.rewardDefinition,
    });
  }

  @Get('rewards/referrer/:referrerId')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get all rewards dispatched to a referrer' })
  async getRewardsByReferrer(@Param('referrerId', ParseUUIDPipe) referrerId: string) {
    return this.rewardService.getByReferrer(referrerId);
  }

  // ── Campaign Endpoints ────────────────────────────────────────────
  @Post('campaigns')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Create a new referral campaign' })
  async createCampaign(@Body() dto: CreateCampaignDto) {
    return this.campaignService.create({
      code: dto.code,
      name: dto.name,
      description: dto.description,
      category: dto.category,
      qualificationRules: dto.qualificationRules,
      rewardDefinition: dto.rewardDefinition,
      maxUses: dto.maxUses,
      startTime: dto.startTime ? new Date(dto.startTime) : undefined,
      endTime: dto.endTime ? new Date(dto.endTime) : undefined,
    });
  }

  @Get('campaigns')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'List all campaigns' })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async listCampaigns(
    @Query('status') status?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.campaignService.findAll(status, parseInt(skip), parseInt(take));
  }

  @Get('campaigns/:id')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get a referral campaign by ID' })
  async getCampaign(@Param('id', ParseUUIDPipe) id: string) {
    return this.campaignService.findById(id);
  }

  @Patch('campaigns/:id/status')
  @RequirePermissions('referral.manage')
  @ApiOperation({ summary: 'Update campaign status (ACTIVE | PAUSED | CANCELLED | ARCHIVED)' })
  async setCampaignStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('status') status: string,
  ) {
    return this.campaignService.setStatus(id, status);
  }

  // ── Summary & Query Endpoints ─────────────────────────────────────
  @Get('summary/:userId')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get referral summary for a user' })
  async getUserSummary(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.queryService.getUserReferralSummary(userId);
  }

  @Get('campaigns/:id/leaderboard')
  @RequirePermissions('referral.view')
  @ApiOperation({ summary: 'Get campaign top-referrer leaderboard' })
  async getCampaignLeaderboard(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limit = '20',
  ) {
    return this.queryService.getCampaignLeaderboard(id, parseInt(limit));
  }

  // ── Statistics Endpoints ──────────────────────────────────────────
  @Get('statistics/summary')
  @RequirePermissions('referral.statistics.view')
  @ApiOperation({ summary: 'Get referral statistics for a period' })
  @ApiQuery({ name: 'period', required: true })
  @ApiQuery({ name: 'dateKey', required: true })
  async getStatistics(
    @Query('period') period: string,
    @Query('dateKey') dateKey: string,
  ) {
    return this.statisticsService.getSummary(period, dateKey);
  }

  @Get('statistics/top-referrers')
  @RequirePermissions('referral.statistics.view')
  @ApiOperation({ summary: 'Get top referrers platform-wide' })
  async getTopReferrers(@Query('limit') limit = '10') {
    return this.statisticsService.getTopReferrers(parseInt(limit));
  }

  @Get('statistics/conversion')
  @RequirePermissions('referral.statistics.view')
  @ApiOperation({ summary: 'Get referral conversion rate' })
  @ApiQuery({ name: 'campaignId', required: false })
  async getConversionRate(@Query('campaignId') campaignId?: string) {
    return { conversionRate: await this.statisticsService.getConversionRate(campaignId) };
  }

  @Get('statistics/campaigns')
  @RequirePermissions('referral.statistics.view')
  @ApiOperation({ summary: 'Get campaign performance breakdown' })
  async getCampaignPerformance() {
    return this.statisticsService.getCampaignPerformance();
  }

  // ── Audit Endpoints ───────────────────────────────────────────────
  @Get('audit/all')
  @RequirePermissions('referral.audit.view')
  @ApiOperation({ summary: 'List all referral audit events' })
  @ApiQuery({ name: 'skip', required: false })
  @ApiQuery({ name: 'take', required: false })
  async getAudit(
    @Query('skip') skip = '0',
    @Query('take') take = '100',
  ) {
    return this.auditService.findAll(parseInt(skip), parseInt(take));
  }

  @Get('audit/relationship/:id')
  @RequirePermissions('referral.audit.view')
  @ApiOperation({ summary: 'Get audit trail for a referral relationship' })
  async getRelationshipAudit(@Param('id', ParseUUIDPipe) id: string) {
    return this.auditService.queryByRelationship(id);
  }

  // ── Configuration Endpoints ───────────────────────────────────────
  @Get('configuration')
  @RequirePermissions('referral.configuration.manage')
  @ApiOperation({ summary: 'Get all referral configuration values' })
  async getConfig() {
    return this.configService.getAll();
  }

  @Patch('configuration')
  @RequirePermissions('referral.configuration.manage')
  @ApiOperation({ summary: 'Update a referral configuration value' })
  async updateConfig(@Body() dto: UpdateConfigDto) {
    await this.configService.set(dto.key, dto.value);
    return { message: 'Configuration updated.' };
  }
}
