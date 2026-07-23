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
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { AuthenticatedUser } from 'src/common/interfaces/authenticated-user';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import {
  AuditLogAction,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  WithdrawalApprovalService,
  WithdrawalAuditService,
  WithdrawalConfigurationService,
  WithdrawalExecutionService,
  WithdrawalHistoryService,
  WithdrawalQueryService,
  WithdrawalService,
  WithdrawalStatisticsService,
} from '../services';

@ApiTags('Enterprise Withdrawal Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('withdrawals')
export class WithdrawalController {
  constructor(
    private readonly withdrawalService: WithdrawalService,
    private readonly approvalService: WithdrawalApprovalService,
    private readonly executionService: WithdrawalExecutionService,
    private readonly historyService: WithdrawalHistoryService,
    private readonly statisticsService: WithdrawalStatisticsService,
    private readonly queryService: WithdrawalQueryService,
    private readonly auditService: WithdrawalAuditService,
    private readonly configService: WithdrawalConfigurationService,
  ) {}

  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('withdrawal.request')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('WITHDRAWAL_REQUESTED', 'withdrawal_request')
  @ApiOperation({ summary: 'Submit a new withdrawal request from eligible earnings' })
  @ApiResponse({ status: 201, description: 'Withdrawal request created & funds reserved' })
  requestWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: { amountCoins: number; payoutMethod?: string; payoutDetails?: Record<string, any> },
  ) {
    return this.withdrawalService.requestWithdrawal({
      userId: user.id,
      amountCoins: BigInt(body.amountCoins),
      payoutMethod: body.payoutMethod,
      payoutDetails: body.payoutDetails,
    });
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('withdrawal.request')
  @ApiOperation({ summary: 'Cancel a pending withdrawal request' })
  @ApiResponse({ status: 200, description: 'Withdrawal request cancelled & hold released' })
  cancelWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) requestId: string,
    @Body() body: { reason?: string },
  ) {
    return this.approvalService.reviewWithdrawal({
      requestId,
      reviewerId: user.id,
      action: 'CANCEL',
      reason: body.reason ?? 'Cancelled by user',
    });
  }

  @Get('summary')
  @RequirePermissions('withdrawal.view')
  @ApiOperation({ summary: 'Global withdrawal summary metrics' })
  @ApiResponse({ status: 200, description: 'Global summary metrics' })
  getSummary() {
    return this.queryService.getGlobalSummary();
  }

  @Get('pending')
  @RequirePermissions('withdrawal.approve')
  @ApiOperation({ summary: 'Pending withdrawal review queue for admins' })
  @ApiResponse({ status: 200, description: 'Pending queue items' })
  getPendingQueue(@Query() q: PaginationQueryDto) {
    return this.queryService.getPendingReviewQueue(q.page, q.limit);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('withdrawal.approve')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('WITHDRAWAL_REVIEWED', 'withdrawal_review')
  @ApiOperation({ summary: 'Admin review (APPROVE / REJECT / UNDER_REVIEW) of withdrawal request' })
  @ApiResponse({ status: 200, description: 'Withdrawal status updated' })
  reviewWithdrawal(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUuidPipe) requestId: string,
    @Body() body: { action: 'APPROVE' | 'REJECT' | 'UNDER_REVIEW'; reason?: string },
  ) {
    return this.approvalService.reviewWithdrawal({
      requestId,
      reviewerId: user.id,
      action: body.action,
      reason: body.reason,
    });
  }

  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('withdrawal.approve')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('WITHDRAWAL_EXECUTED', 'withdrawal_payout')
  @ApiOperation({ summary: 'Execute payout for an APPROVED withdrawal request' })
  @ApiResponse({ status: 200, description: 'Payout executed & funds debited' })
  executePayout(
    @Param('id', ParseUuidPipe) requestId: string,
    @Body() body: { payoutTxnId?: string },
  ) {
    return this.executionService.executePayout({
      requestId,
      payoutTxnId: body.payoutTxnId,
    });
  }

  @Get('history')
  @RequirePermissions('withdrawal.history.view')
  @ApiOperation({ summary: 'Paginated user or global withdrawal history' })
  @ApiResponse({ status: 200, description: 'Withdrawal history' })
  getHistory(
    @CurrentUser() user: AuthenticatedUser,
    @Query() q: PaginationQueryDto & { userId?: string; status?: string },
  ) {
    const targetUser = q.userId ?? user.id;
    return this.historyService.getWithdrawalHistory(targetUser, {
      page: q.page,
      limit: q.limit,
      status: q.status,
    });
  }

  @Get(':id')
  @RequirePermissions('withdrawal.view')
  @ApiOperation({ summary: 'Get single withdrawal request details' })
  @ApiResponse({ status: 200, description: 'Withdrawal details' })
  getWithdrawal(@Param('id', ParseUuidPipe) requestId: string) {
    return this.withdrawalService.getWithdrawalRequest(requestId);
  }

  @Get('statistics/:userId')
  @RequirePermissions('withdrawal.view')
  @ApiOperation({ summary: 'User daily, monthly, lifetime withdrawal statistics' })
  @ApiResponse({ status: 200, description: 'User withdrawal statistics' })
  getUserStatistics(@Param('userId', ParseUuidPipe) userId: string) {
    return this.statisticsService.getUserStatistics(userId);
  }

  @Get('audit')
  @RequirePermissions('withdrawal.audit.view')
  @ApiOperation({ summary: 'Withdrawal operational audit event logs' })
  @ApiResponse({ status: 200, description: 'Audit log entries' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('withdrawal.configuration.manage')
  @ApiOperation({ summary: 'Active withdrawal configuration parameters' })
  @ApiResponse({ status: 200, description: 'Withdrawal configuration' })
  getConfiguration() {
    return this.configService.getWithdrawalConfig();
  }

  @Put('configuration')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('withdrawal.configuration.manage')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('WITHDRAWAL_CONFIGURATION_UPDATED', 'withdrawal_configuration')
  @ApiOperation({ summary: 'Update dynamic withdrawal configuration parameter' })
  @ApiResponse({ status: 200, description: 'Configuration updated' })
  updateConfiguration(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { key: string; value: any },
  ) {
    return this.configService.updateConfigParameter(body.key, body.value);
  }
}
