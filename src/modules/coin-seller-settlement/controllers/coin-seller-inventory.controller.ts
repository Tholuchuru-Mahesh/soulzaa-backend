import { Controller, Post, Body, Req, UseGuards, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoinSellerInventoryService } from '../services/coin-seller-inventory.service';
import { CoinSellerUserSaleService } from '../services/coin-seller-user-sale.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import { PurchaseInventoryDto, SellCoinsDto } from '../dto/coin-seller-inventory.dto';

@ApiTags('Coin Seller Inventory')
@ApiBearerAuth()
@Controller('admin/coin-seller/inventory')
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
export class CoinSellerInventoryController {
  constructor(
    private readonly inventoryService: CoinSellerInventoryService,
    private readonly userSaleService: CoinSellerUserSaleService,
  ) {}

  @ApiOperation({ summary: 'Order bulk Gold Coin inventory from the platform' })
  @Post('purchase')
  @RequirePermissions('coin_seller.inventory.purchase')
  async purchaseInventory(@Req() req: any, @Body() dto: PurchaseInventoryDto) {
    const sellerId = req.user.id;
    return this.inventoryService.createPurchaseOrder(sellerId, dto.packageId, dto.idempotencyKey);
  }

  @ApiOperation({ summary: 'Sell Gold Coins from seller inventory to a user' })
  @Post('sell')
  @RequirePermissions('coin_seller.inventory.sell')
  async sellCoins(@Req() req: any, @Body() dto: SellCoinsDto) {
    const sellerId = req.user.id;
    return this.userSaleService.sellCoinsToUser(
      sellerId,
      dto.buyerId,
      dto.amount,
      dto.idempotencyKey,
    );
  }

  @ApiOperation({ summary: 'Approve a pending inventory purchase order' })
  @Post('purchase-orders/:orderId/approve')
  @RequirePermissions('coin_seller.inventory.approve')
  async approvePurchaseOrder(@Req() req: any, @Param('orderId') orderId: string) {
    const adminId = req.user.id;
    return this.inventoryService.approvePurchaseOrder(orderId, adminId);
  }
}
