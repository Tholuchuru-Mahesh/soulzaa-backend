import { Controller, Post, Get, Body, Query, Req, UseGuards, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CoinSellerInventoryService } from '../services/coin-seller-inventory.service';
import { CoinSellerUserSaleService } from '../services/coin-seller-user-sale.service';
import { CoinSellerCheckoutService } from '../services/coin-seller-checkout.service';
import { CoinSellerPanelService } from '../services/coin-seller-panel.service';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RequirePermissions } from 'src/modules/authorization/decorators/authorization.decorators';
import {
  CoinHistoryQueryDto,
  ConfirmInventoryPaymentDto,
  PurchaseInventoryDto,
  SellCoinsDto,
} from '../dto/coin-seller-inventory.dto';

@ApiTags('Coin Seller Inventory')
@ApiBearerAuth()
@Controller('admin/coin-seller/inventory')
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
export class CoinSellerInventoryController {
  constructor(
    private readonly inventoryService: CoinSellerInventoryService,
    private readonly userSaleService: CoinSellerUserSaleService,
    private readonly checkoutService: CoinSellerCheckoutService,
    private readonly panelService: CoinSellerPanelService,
  ) {}

  @ApiOperation({ summary: "This seller's inventory balances and recent totals" })
  @Get()
  @RequirePermissions('coin_seller.inventory.purchase')
  async getInventory(@Req() req: any) {
    return this.panelService.getInventorySummary(req.user.id);
  }

  @ApiOperation({ summary: 'Wholesale coin packages an agency can buy' })
  @Get('packages')
  @RequirePermissions('coin_seller.inventory.purchase')
  async listPackages() {
    return this.panelService.listPackages();
  }

  @ApiOperation({ summary: 'Coins sent to users and inventory added, newest first' })
  @Get('history')
  @RequirePermissions('coin_seller.inventory.purchase')
  async getHistory(@Req() req: any, @Query() query: CoinHistoryQueryDto) {
    return this.panelService.listHistory(req.user.id, {
      type: query.type,
      limit: query.limit,
    });
  }

  @ApiOperation({ summary: 'Order bulk Gold Coin inventory from the platform' })
  @Post('purchase')
  @RequirePermissions('coin_seller.inventory.purchase')
  async purchaseInventory(@Req() req: any, @Body() dto: PurchaseInventoryDto) {
    const sellerId = req.user.id;
    return this.inventoryService.createPurchaseOrder(sellerId, dto.packageId, dto.idempotencyKey);
  }

  @ApiOperation({ summary: 'Open Razorpay checkout for an inventory package' })
  @Post('checkout')
  @RequirePermissions('coin_seller.inventory.purchase')
  async startCheckout(@Req() req: any, @Body() dto: PurchaseInventoryDto) {
    return this.checkoutService.startCheckout(req.user.id, dto.packageId, dto.idempotencyKey);
  }

  @ApiOperation({ summary: 'Create a hosted Razorpay payment page for a package' })
  @Post('payment-link')
  @RequirePermissions('coin_seller.inventory.purchase')
  async createPaymentLink(@Req() req: any, @Body() dto: PurchaseInventoryDto) {
    return this.checkoutService.createPaymentLink(req.user.id, dto.packageId, dto.idempotencyKey);
  }

  @ApiOperation({ summary: 'Confirm a Razorpay payment and credit the inventory' })
  @Post('checkout/confirm')
  @RequirePermissions('coin_seller.inventory.purchase')
  async confirmCheckout(@Req() req: any, @Body() dto: ConfirmInventoryPaymentDto) {
    return this.checkoutService.confirmCheckout(
      req.user.id,
      dto.purchaseOrderId,
      dto.razorpayPaymentId,
      dto.razorpaySignature,
    );
  }

  @ApiOperation({ summary: 'Payment state of one of this seller’s purchase orders' })
  @Get('purchase-orders/:orderId')
  @RequirePermissions('coin_seller.inventory.purchase')
  async getPurchaseOrderStatus(@Req() req: any, @Param('orderId') orderId: string) {
    return this.panelService.getPurchaseOrderStatus(req.user.id, orderId);
  }

  @ApiOperation({ summary: 'Find a buyer by user id or username, within your country' })
  @Get('buyer-lookup')
  @RequirePermissions('coin_seller.inventory.sell')
  async lookupBuyer(@Req() req: any, @Query('query') query: string) {
    return this.panelService.lookupBuyer(req.user.id, query ?? '');
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
