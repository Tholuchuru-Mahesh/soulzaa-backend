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
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  CreateCoinPackageDto,
  PackageQueryDto,
  UpdateCoinPackageDto,
} from 'src/modules/payments/dto/coin-package.dto';
import { OrderQueryDto, VerifyPurchaseDto } from 'src/modules/payments/dto/purchase-order.dto';
import { CoinPackageService } from 'src/modules/payments/services/coin-package.service';
import { PurchaseAuditService } from 'src/modules/payments/services/purchase-audit.service';
import { PurchaseQueryService } from 'src/modules/payments/services/purchase-query.service';
import { ReceiptVerificationService } from 'src/modules/payments/services/receipt-verification.service';

@ApiTags('Super Admin - Coin Purchase & Payment Infrastructure')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/purchases')
export class SuperAdminPurchaseController {
  constructor(
    private readonly packageService: CoinPackageService,
    private readonly queryService: PurchaseQueryService,
    private readonly verificationService: ReceiptVerificationService,
    private readonly auditService: PurchaseAuditService,
  ) {}

  // ---------------------------------------------------------
  // Coin Package Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List coin packages (Admin view)' })
  @ApiResponse({ status: 200, description: 'List of coin packages' })
  @RequirePermissions('purchase.package.view')
  @Get('packages')
  async listPackages(@Query() queryDto: PackageQueryDto) {
    return this.packageService.listPackages(queryDto);
  }

  @ApiOperation({ summary: 'Create a new purchasable coin package' })
  @ApiResponse({ status: 201, description: 'Coin package created' })
  @RequirePermissions('purchase.package.view')
  @AuditLogAction('PACKAGE_CREATED', 'coin_package')
  @Post('packages')
  async createPackage(@Body() dto: CreateCoinPackageDto, @CurrentUser('id') actorId: string) {
    return this.packageService.createPackage(dto, actorId);
  }

  @ApiOperation({ summary: 'Update an existing coin package' })
  @ApiResponse({ status: 200, description: 'Coin package updated' })
  @RequirePermissions('purchase.package.view')
  @AuditLogAction('PACKAGE_UPDATED', 'coin_package')
  @Put('packages/:id')
  async updatePackage(
    @Param('id') id: string,
    @Body() dto: UpdateCoinPackageDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.packageService.updatePackage(id, dto, actorId);
  }

  // ---------------------------------------------------------
  // Purchase Order & Verification APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List all platform purchase orders' })
  @ApiResponse({ status: 200, description: 'Paginated list of purchase orders' })
  @RequirePermissions('purchase.order.view')
  @Get('orders')
  async listAllOrders(@Query() queryDto: OrderQueryDto) {
    return this.queryService.listAllOrders(queryDto);
  }

  @ApiOperation({ summary: 'Retry receipt verification for stuck or failed purchase orders' })
  @ApiResponse({ status: 200, description: 'Receipt verification retried' })
  @RequirePermissions('purchase.verify')
  @AuditLogAction('RECEIPT_VERIFIED', 'purchase_order')
  @Post('orders/retry-verify')
  @HttpCode(HttpStatus.OK)
  async retryVerification(@Body() dto: VerifyPurchaseDto, @CurrentUser('id') actorId: string) {
    // Admin path: a super admin retrying a stuck/failed order routinely acts on an
    // order that isn't theirs, so this deliberately bypasses the caller-ownership
    // check enforced for the user-facing verify endpoint. Safe only because this
    // controller is gated by @RequireRoles('SUPER_ADMIN') + RBAC permission guards.
    return this.verificationService.verifyAndFulfillPurchaseAsAdmin(dto, actorId);
  }

  @ApiOperation({ summary: 'View purchase operational audit log history' })
  @ApiResponse({ status: 200, description: 'Purchase audit history' })
  @RequirePermissions('purchase.audit.view')
  @Get('audit')
  async getPurchaseAuditHistory(@Query('purchaseOrderId') purchaseOrderId?: string) {
    return this.auditService.getPurchaseAuditHistory(purchaseOrderId);
  }
}
