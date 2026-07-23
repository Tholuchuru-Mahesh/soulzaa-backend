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
  CoinSellerAuditService,
  CoinSellerConfigurationService,
  CoinSellerHistoryService,
  CoinSellerQueryService,
  CoinSellerRelationshipService,
  CoinSellerStatisticsService,
} from '../services';

@ApiTags('Coin Seller Settlement Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@Controller('coin-seller/settlement')
export class CoinSellerSettlementController {
  constructor(
    private readonly queryService: CoinSellerQueryService,
    private readonly historyService: CoinSellerHistoryService,
    private readonly statisticsService: CoinSellerStatisticsService,
    private readonly auditService: CoinSellerAuditService,
    private readonly configService: CoinSellerConfigurationService,
    private readonly relationshipService: CoinSellerRelationshipService,
  ) {}

  @Get('summary')
  @RequirePermissions('coin_seller.settlement.view')
  @ApiOperation({ summary: 'Global Coin Seller Settlement Summary' })
  @ApiResponse({ status: 200, description: 'Global coin seller settlement metrics' })
  getSummary() {
    return this.queryService.getGlobalSummary();
  }

  @Get('history')
  @RequirePermissions('coin_seller.settlement.history.view')
  @ApiOperation({ summary: 'Coin seller settlement history logs' })
  @ApiResponse({ status: 200, description: 'Paginated coin seller settlement history' })
  getHistory(@Query() q: PaginationQueryDto) {
    return this.historyService.getSellerSettlementHistory('', { page: q.page, limit: q.limit });
  }

  @Get('seller/:sellerId')
  @RequirePermissions('coin_seller.settlement.view')
  @ApiOperation({ summary: 'Coin seller specific settlement history' })
  @ApiResponse({ status: 200, description: 'Seller settlement history' })
  getSellerEarnings(
    @Param('sellerId', ParseUuidPipe) sellerId: string,
    @Query() q: PaginationQueryDto,
  ) {
    return this.historyService.getSellerSettlementHistory(sellerId, {
      page: q.page,
      limit: q.limit,
    });
  }

  @Get('statistics/:sellerId')
  @RequirePermissions('coin_seller.settlement.view')
  @ApiOperation({ summary: 'Coin seller daily, weekly, monthly, lifetime statistics' })
  @ApiResponse({ status: 200, description: 'Coin seller statistics' })
  getSellerStatistics(@Param('sellerId', ParseUuidPipe) sellerId: string) {
    return this.statisticsService.getSellerStatistics(sellerId);
  }

  @Get('audit')
  @RequirePermissions('coin_seller.settlement.audit.view')
  @ApiOperation({ summary: 'Coin seller settlement audit event logs' })
  @ApiResponse({ status: 200, description: 'Audit log entries' })
  getAudit(@Query() q: PaginationQueryDto) {
    return this.auditService.getAuditLogs(undefined, q.page, q.limit);
  }

  @Get('configuration')
  @RequirePermissions('coin_seller.settlement.configuration.manage')
  @ApiOperation({ summary: 'Active dynamic coin seller commission percentage' })
  @ApiResponse({ status: 200, description: 'Coin seller configuration' })
  getConfiguration() {
    return this.configService.getCommissionConfig();
  }

  @Put('configuration')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('coin_seller.settlement.configuration.manage')
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('COIN_SELLER_CONFIGURATION_UPDATED', 'coin_seller_configuration')
  @ApiOperation({ summary: 'Update dynamic coin seller commission configuration parameter' })
  @ApiResponse({ status: 200, description: 'Configuration updated' })
  updateConfiguration(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { key: string; value: any },
  ) {
    return this.configService.updateConfigParameter(body.key, body.value);
  }

  @Get('reports')
  @RequirePermissions('coin_seller.settlement.view')
  @ApiOperation({ summary: 'Top earning coin sellers report' })
  @ApiResponse({ status: 200, description: 'Top sellers report' })
  getTopSellersReport(@Query('limit') limit = 10) {
    return this.queryService.getTopSellers(Number(limit));
  }

  @Post('relationship/assign')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('coin_seller.settlement.configuration.manage')
  @ApiOperation({ summary: 'Assign a buyer to a coin seller' })
  assignBuyer(@Body() body: { sellerId: string; buyerId: string }) {
    return this.relationshipService.assignBuyerToSeller(body.sellerId, body.buyerId);
  }
}
