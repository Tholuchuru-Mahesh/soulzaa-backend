import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  AuditLogAction,
  CurrentUser,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import { PackageQueryDto } from '../dto/coin-package.dto';
import {
  CreatePurchaseOrderDto,
  OrderQueryDto,
  VerifyPurchaseDto,
} from '../dto/purchase-order.dto';
import { CoinPackageService } from '../services/coin-package.service';
import { PurchaseOrderService } from '../services/purchase-order.service';
import { PurchaseQueryService } from '../services/purchase-query.service';
import { ReceiptVerificationService } from '../services/receipt-verification.service';

@ApiTags('Coin Purchase & Payments')
@Controller('payments')
export class CoinPurchaseController {
  constructor(
    private readonly packageService: CoinPackageService,
    private readonly orderService: PurchaseOrderService,
    private readonly verificationService: ReceiptVerificationService,
    private readonly queryService: PurchaseQueryService,
  ) {}

  // ---------------------------------------------------------
  // Public Coin Packages Catalog APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List active purchasable coin packages' })
  @ApiResponse({ status: 200, description: 'List of coin packages' })
  @Get('packages')
  async listPackages(@Query() queryDto: PackageQueryDto) {
    return this.packageService.listPackages(queryDto);
  }

  @ApiOperation({ summary: 'Get coin package details by ID or code' })
  @ApiResponse({ status: 200, description: 'Coin package details' })
  @Get('packages/:id')
  async getPackageById(@Param('id') id: string) {
    return this.packageService.getPackageById(id);
  }

  // ---------------------------------------------------------
  // Authenticated Purchase Lifecycle APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Create a new coin purchase order' })
  @ApiResponse({ status: 201, description: 'Purchase order created successfully' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('PURCHASE_ORDER_CREATED', 'purchase_order')
  @Post('orders')
  async createPurchaseOrder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.orderService.createPurchaseOrder(userId, dto);
  }

  @ApiOperation({ summary: 'Submit payment receipt for verification & wallet crediting' })
  @ApiResponse({ status: 200, description: 'Receipt verified and wallet credited' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(AuditLogInterceptor)
  @AuditLogAction('PURCHASE_VERIFIED', 'purchase_order')
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verifyPurchase(@CurrentUser('id') userId: string, @Body() dto: VerifyPurchaseDto) {
    return this.verificationService.verifyAndFulfillPurchase(dto, userId);
  }

  @ApiOperation({ summary: 'Get current user purchase order history' })
  @ApiResponse({ status: 200, description: 'User purchase order history' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('orders/my-history')
  async getMyPurchaseHistory(@CurrentUser('id') userId: string, @Query() queryDto: OrderQueryDto) {
    return this.queryService.getUserPurchaseHistory(userId, queryDto);
  }

  @ApiOperation({ summary: 'Get purchase order details' })
  @ApiResponse({ status: 200, description: 'Purchase order details' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('orders/:id')
  async getOrderDetails(@Param('id') id: string) {
    return this.queryService.getOrderDetails(id);
  }
}
