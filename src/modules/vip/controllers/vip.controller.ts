import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import {
  AuditLogAction,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  VipAuditService,
  VipBenefitService,
  VipConfigurationService,
  VipHistoryService,
  VipMembershipService,
  VipQueryService,
  VipRewardService,
  VipStatisticsService,
  VipSubscriptionService,
  VipTierService,
} from '../services';

@ApiTags('Enterprise VIP Membership Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('vip')
export class VipController {
  constructor(
    private readonly tierService: VipTierService,
    private readonly subscriptionService: VipSubscriptionService,
    private readonly membershipService: VipMembershipService,
    private readonly benefitService: VipBenefitService,
    private readonly rewardService: VipRewardService,
    private readonly queryService: VipQueryService,
    private readonly historyService: VipHistoryService,
    private readonly auditService: VipAuditService,
    private readonly statisticsService: VipStatisticsService,
    private readonly configService: VipConfigurationService,
  ) {}

  @Get('tiers')
  @RequirePermissions('vip.view')
  @ApiOperation({ summary: 'List active VIP membership tiers' })
  @ApiResponse({ status: 200, description: 'List of active VIP tiers' })
  getTiers() {
    return this.tierService.getActiveTiers();
  }

  @Post('purchase')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.purchase')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('VIP_CREATED', 'vip')
  @ApiOperation({ summary: 'Purchase a new VIP membership subscription' })
  purchaseVip(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { level: number; autoRenew?: boolean },
  ) {
    return this.subscriptionService.purchaseVip({
      userId: user.id,
      level: body.level,
      autoRenew: body.autoRenew,
    });
  }

  @Post('renew')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.purchase')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('VIP_RENEWED', 'vip')
  @ApiOperation({ summary: 'Renew existing active VIP membership' })
  renewVip(@CurrentUser() user: AuthenticatedUser) {
    return this.subscriptionService.renewVip(user.id);
  }

  @Post('upgrade')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.purchase')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('VIP_UPGRADED', 'vip')
  @ApiOperation({ summary: 'Upgrade VIP membership to a higher level' })
  upgradeVip(@CurrentUser() user: AuthenticatedUser, @Body() body: { targetLevel: number }) {
    return this.subscriptionService.upgradeVip(user.id, body.targetLevel);
  }

  @Post('gift')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.purchase')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('VIP_CREATED', 'vip')
  @ApiOperation({ summary: 'Gift VIP membership to another user' })
  giftVip(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { recipientUserId: string; level: number },
  ) {
    return this.subscriptionService.giftVip({
      gifterUserId: user.id,
      recipientUserId: body.recipientUserId,
      level: body.level,
    });
  }

  @Get('me')
  @RequirePermissions('vip.view')
  @ApiOperation({ summary: 'Get current user VIP membership details and active entitlements' })
  getVipDetails(@CurrentUser() user: AuthenticatedUser) {
    return this.queryService.getUserVipDetails(user.id);
  }

  @Get('benefits')
  @RequirePermissions('vip.view')
  @ApiOperation({ summary: 'Get user active VIP entitlements and cosmetic perks' })
  getBenefits(@CurrentUser() user: AuthenticatedUser) {
    return this.benefitService.getUserEntitlements(user.id);
  }

  @Post('rewards/claim')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.view')
  @ApiOperation({ summary: 'Claim daily, weekly, or monthly VIP tier rewards' })
  claimReward(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { rewardType: 'DAILY' | 'WEEKLY' | 'MONTHLY' },
  ) {
    return this.rewardService.claimReward(user.id, body.rewardType);
  }

  @Post('suspend')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.manage')
  @ApiOperation({ summary: 'Suspend a user VIP membership (Admin)' })
  suspendMembership(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { targetUserId: string; reason?: string },
  ) {
    return this.membershipService.suspendMembership(body.targetUserId, user.id, body.reason);
  }

  @Post('restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('vip.manage')
  @ApiOperation({ summary: 'Restore a suspended VIP membership (Admin)' })
  restoreMembership(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { targetUserId: string },
  ) {
    return this.membershipService.restoreMembership(body.targetUserId, user.id);
  }

  @Get('statistics')
  @RequirePermissions('vip.statistics.view')
  @ApiOperation({ summary: 'Get aggregated VIP sales and renewal statistics' })
  getStatistics() {
    return this.statisticsService.getStatistics();
  }

  @Get('history')
  @RequirePermissions('vip.view')
  @ApiOperation({ summary: 'Get VIP lifecycle history' })
  getHistory(@CurrentUser() user: AuthenticatedUser, @Query() q: PaginationQueryDto) {
    return this.historyService.getHistory(user.id, { page: q.page, limit: q.limit });
  }

  @Get('audit')
  @RequirePermissions('vip.audit.view')
  @ApiOperation({ summary: 'Get VIP operational audit event logs' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('vip.configuration.manage')
  @ApiOperation({ summary: 'Get dynamic VIP configuration parameters' })
  getConfiguration() {
    return this.configService.getVipConfig();
  }
}
