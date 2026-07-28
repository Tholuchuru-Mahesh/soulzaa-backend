import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { MobilePartnerService } from '../services/mobile-partner.service';

/**
 * Mobile console for external partners — Agency, Coin Seller and Host.
 *
 * Gated on `mobile.partner.view`. No route accepts a partner id: the subject is
 * always the authenticated user, so ownership cannot be bypassed by editing a
 * request. A caller without rows for a given surface gets an empty result.
 */
@ApiTags('Mobile — Partner')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.partner.view')
@Controller('mobile/partner')
export class MobilePartnerController {
  constructor(private readonly service: MobilePartnerService) {}

  @ApiOperation({ summary: 'Agency summary — commission earned and my hosts' })
  @ApiQuery({ name: 'hosts', required: false, description: 'Host list size (default 50)' })
  @ApiResponse({ status: 200, description: 'Own agency totals and active hosts' })
  @Get('agency/summary')
  agencySummary(@CurrentUser('id') userId: string, @Query('hosts') hosts?: string) {
    return this.service.agencySummary(userId, Number(hosts) || 50);
  }

  @ApiOperation({ summary: 'Agency settlement history' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Own agency settlements, newest first' })
  @Get('agency/settlements')
  agencySettlements(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.agencySettlements(userId, Number(limit) || 25, Number(offset) || 0);
  }

  @ApiOperation({ summary: 'Coin seller summary — sales volume and commission' })
  @ApiQuery({ name: 'buyers', required: false, description: 'Buyer list size (default 50)' })
  @ApiResponse({ status: 200, description: 'Own seller totals and active buyers' })
  @Get('seller/summary')
  sellerSummary(@CurrentUser('id') userId: string, @Query('buyers') buyers?: string) {
    return this.service.sellerSummary(userId, Number(buyers) || 50);
  }

  @ApiOperation({ summary: 'Coin seller settlement history' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Own seller settlements, newest first' })
  @Get('seller/settlements')
  sellerSettlements(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.sellerSettlements(userId, Number(limit) || 25, Number(offset) || 0);
  }

  @ApiOperation({ summary: 'Host earnings — lifetime, withdrawable and agency' })
  @ApiResponse({ status: 200, description: 'Own host earnings and withdrawal state' })
  @Get('host/earnings')
  hostEarnings(@CurrentUser('id') userId: string) {
    return this.service.hostEarnings(userId);
  }

  @ApiOperation({ summary: 'Host gift history — gifts I received' })
  @ApiQuery({ name: 'limit', required: false, description: 'Page size (default 25, max 100)' })
  @ApiQuery({ name: 'offset', required: false, description: 'Page offset (default 0)' })
  @ApiResponse({ status: 200, description: 'Own received gift transactions' })
  @Get('host/gifts')
  hostGifts(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.service.hostGiftHistory(userId, Number(limit) || 25, Number(offset) || 0);
  }
}
