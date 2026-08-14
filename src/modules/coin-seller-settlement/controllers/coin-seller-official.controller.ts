import {
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';

/**
 * Read-only coin-seller views for the Official Portal.
 *
 * Officials may see coin sellers in their territory and review their
 * inventory — they cannot modify sellers, pricing, or settlements.
 */
@ApiTags('Official — Coin Sellers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.workforce.view')
@Controller('coin-seller/official')
export class CoinSellerOfficialController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
  ) {}

  @ApiOperation({ summary: 'List coin sellers in my territory (read-only)' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Coin sellers scoped to Official territory' })
  @Get('list')
  async list(
    @CurrentUser('id') officialId: string,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);

    // Coin seller inventories store a `country` string field (ISO code), not
    // a UUID. We resolve seller user IDs from the scope and join through them.
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    let sellerIds: string[] | undefined;
    if (!isUnrestricted) {
      const sellers = await this.prisma.user.findMany({
        where: { ...scopeWhere, roles: { hasSome: ['COIN_SELLER'] as any } },
        select: { id: true },
        take: 10_000,
      });
      sellerIds = sellers.map((s) => s.id);
    }

    const where = sellerIds !== undefined ? { sellerId: { in: sellerIds } } : {};

    const [total, items] = await Promise.all([
      this.prisma.coinSellerInventory.count({ where }),
      this.prisma.coinSellerInventory.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
        select: {
          id: true,
          sellerId: true,
          country: true,
          availableBalance: true,
          soldTotal: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    return { total, items };
  }

  @ApiOperation({ summary: 'View a specific coin seller inventory in my territory' })
  @ApiResponse({ status: 200, description: 'Coin seller inventory detail' })
  @Get(':sellerId/inventory')
  async sellerInventory(
    @Param('sellerId', ParseUUIDPipe) sellerId: string,
    @CurrentUser('id') officialId: string,
  ) {
    const scopeWhere = await this.scope.userScopeFilter(officialId);
    const isUnrestricted = Object.keys(scopeWhere).length === 0;

    // Verify the seller is in this Official's territory
    if (!isUnrestricted) {
      const inScope = await this.prisma.user.count({
        where: { id: sellerId, ...scopeWhere },
      });
      if (inScope === 0) {
        return { message: 'Seller is not in your territory' };
      }
    }

    const [inventory, packages, recentSales] = await Promise.all([
      this.prisma.coinSellerInventory.findUnique({ where: { sellerId } }),
      this.prisma.coinSellerInventoryPackage.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.coinSellerUserSaleTransaction.findMany({
        where: { sellerId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          buyerId: true,
          coinAmount: true,
          status: true,
          createdAt: true,
        },
      }),
    ]);

    return { inventory, packages, recentSales };
  }
}
