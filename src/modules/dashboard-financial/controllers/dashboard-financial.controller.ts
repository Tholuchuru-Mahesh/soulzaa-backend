import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { DashboardFinancialService } from '../services/dashboard-financial.service';

/** `?days=30` → a rolling window; omitted means all time. */
function toRange(days?: string) {
  const parsed = Number(days);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  return { since: new Date(Date.now() - parsed * 24 * 60 * 60 * 1000) };
}

/**
 * Financial web dashboards for the admin console.
 *
 * Every route is gated on `dashboard.financial.view`, which only ADMIN holds
 * (SUPER_ADMIN passes via its wildcard). The seven operational roles hold no
 * dashboard permission at all — they reach the platform through the mobile app.
 *
 * Read-only by construction: there is no write route here, and money movement
 * stays with the wallet, revenue, withdrawal and settlement engines.
 */
@ApiTags('Dashboard — Financial')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('dashboard.financial.view')
@Controller('dashboard/financial')
export class DashboardFinancialController {
  constructor(private readonly service: DashboardFinancialService) {}

  @ApiOperation({ summary: 'Financial overview — float, earnings and payouts' })
  @ApiQuery({ name: 'days', required: false, description: 'Rolling window in days' })
  @ApiResponse({ status: 200, description: 'Platform-wide financial position' })
  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.service.financialOverview(toRange(days));
  }

  @ApiOperation({ summary: 'Wallet management — balances and ledger volume' })
  @ApiResponse({ status: 200, description: 'Wallet totals broken down by status' })
  @Get('wallets')
  wallets() {
    return this.service.walletDashboard();
  }

  @ApiOperation({ summary: 'Treasury monitoring — supply, policies and freeze state' })
  @ApiResponse({ status: 200, description: 'Treasury reserve, financial policies, recent log' })
  @Get('treasury')
  treasury() {
    return this.service.treasuryDashboard();
  }

  @ApiOperation({ summary: 'Revenue dashboard — distribution split and top hosts' })
  @ApiQuery({ name: 'days', required: false, description: 'Rolling window in days' })
  @ApiQuery({ name: 'topHosts', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Revenue totals and highest-earning hosts' })
  @Get('revenue')
  revenue(@Query('days') days?: string, @Query('topHosts') topHosts?: string) {
    return this.service.revenueDashboard(toRange(days), Number(topHosts) || 10);
  }

  @ApiOperation({ summary: 'Withdrawal operations — approval queue and payouts' })
  @ApiQuery({ name: 'pendingLimit', required: false, description: 'Queue page size (default 25)' })
  @ApiResponse({ status: 200, description: 'Withdrawal counts by status and pending queue' })
  @Get('withdrawals')
  withdrawals(@Query('pendingLimit') pendingLimit?: string) {
    return this.service.withdrawalDashboard(Number(pendingLimit) || 25);
  }

  @ApiOperation({ summary: 'Agency settlements — commission paid and top agencies' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Agency settlement totals' })
  @Get('agencies')
  agencies(@Query('top') top?: string) {
    return this.service.agencyDashboard(Number(top) || 10);
  }

  @ApiOperation({ summary: 'Coin seller settlements — volume and top sellers' })
  @ApiQuery({ name: 'top', required: false, description: 'Leaderboard size (default 10)' })
  @ApiResponse({ status: 200, description: 'Coin seller settlement totals' })
  @Get('coin-sellers')
  coinSellers(@Query('top') top?: string) {
    return this.service.coinSellerDashboard(Number(top) || 10);
  }
}
