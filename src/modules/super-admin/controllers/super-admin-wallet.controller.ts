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
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  CreditWalletDto,
  DebitWalletDto,
  TransferWalletDto,
} from 'src/modules/wallet/dto/create-transaction.dto';
import {
  LedgerQueryDto,
  TransactionQueryFilterDto,
  WalletQueryDto,
} from 'src/modules/wallet/dto/wallet-query.dto';
import { BalanceService } from 'src/modules/wallet/services/balance.service';
import { TransactionQueryService } from 'src/modules/wallet/services/transaction-query.service';
import { WalletAuditService } from 'src/modules/wallet/services/wallet-audit.service';
import { WalletTransactionService } from 'src/modules/wallet/services/wallet-transaction.service';

@ApiTags('Super Admin - Enterprise Wallet & Double-Entry Ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/wallets')
export class SuperAdminWalletController {
  constructor(
    private readonly queryService: TransactionQueryService,
    private readonly balanceService: BalanceService,
    private readonly transactionService: WalletTransactionService,
    private readonly auditService: WalletAuditService,
  ) {}

  // ---------------------------------------------------------
  // Ecosystem Overview & Wallet Listing APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get total wallet ecosystem balance metrics' })
  @ApiResponse({ status: 200, description: 'Wallet ecosystem summary' })
  @RequirePermissions('wallet.view')
  @Get('summary')
  async getWalletEcosystemSummary() {
    return this.queryService.getWalletEcosystemSummary();
  }

  @ApiOperation({ summary: 'Search and filter platform wallet accounts' })
  @ApiResponse({ status: 200, description: 'Paginated list of wallet accounts' })
  @RequirePermissions('wallet.view')
  @Get()
  async listWallets(@Query() filterDto: WalletQueryDto) {
    return this.queryService.listWallets(filterDto);
  }

  @ApiOperation({ summary: 'Get wallet details & balance projection' })
  @ApiResponse({ status: 200, description: 'Wallet details and balances' })
  @RequirePermissions('wallet.view')
  @Get(':id')
  async getWalletDetails(@Param('id') id: string) {
    return this.queryService.getWalletDetails(id);
  }

  // ---------------------------------------------------------
  // Balance Reconciliation & Immutable Ledger APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Reconcile cached wallet balance against double-entry ledger sum' })
  @ApiResponse({ status: 200, description: 'Ledger reconciliation analysis' })
  @RequirePermissions('wallet.balance.view')
  @Get(':id/balance')
  async reconcileBalanceWithLedger(@Param('id') id: string) {
    return this.balanceService.reconcileBalanceWithLedger(id);
  }

  @ApiOperation({ summary: 'View immutable double-entry ledger history for a wallet' })
  @ApiResponse({ status: 200, description: 'Immutable ledger entry list' })
  @RequirePermissions('wallet.transaction.view')
  @Get(':id/ledger')
  async getLedgerHistory(@Param('id') id: string, @Query() queryDto: LedgerQueryDto) {
    return this.queryService.getLedgerHistory(id, queryDto);
  }

  @ApiOperation({ summary: 'View transaction history for a wallet' })
  @ApiResponse({ status: 200, description: 'Transaction history' })
  @RequirePermissions('wallet.transaction.view')
  @Get(':id/transactions')
  async getTransactionHistory(
    @Param('id') id: string,
    @Query() queryDto: TransactionQueryFilterDto,
  ) {
    return this.queryService.getTransactionHistory(id, queryDto);
  }

  @ApiOperation({ summary: 'View single transaction details and paired ledger entries' })
  @ApiResponse({ status: 200, description: 'Transaction details' })
  @RequirePermissions('wallet.transaction.view')
  @Get('transactions/:txnId')
  async getTransactionDetails(@Param('txnId') txnId: string) {
    return this.queryService.getTransactionDetails(txnId);
  }

  @ApiOperation({ summary: 'View active and historical coin reservations for a wallet' })
  @ApiResponse({ status: 200, description: 'Coin reservations list' })
  @RequirePermissions('wallet.reservation.view')
  @Get(':id/reservations')
  async listReservations(@Param('id') id: string) {
    return this.queryService.listReservations(id);
  }

  @ApiOperation({ summary: 'View audit log history for a wallet' })
  @ApiResponse({ status: 200, description: 'Wallet audit history' })
  @RequirePermissions('wallet.audit.view')
  @Get(':id/audit')
  async getWalletAuditHistory(@Param('id') id: string) {
    return this.auditService.getWalletAuditHistory(id);
  }

  // ---------------------------------------------------------
  // Double-Entry Transaction Execution Infrastructure APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Credit a user wallet account with paired double-entry ledger record' })
  @ApiResponse({ status: 200, description: 'Wallet credited successfully' })
  @RequirePermissions('wallet.view')
  @AuditLogAction('TRANSACTION_CREATED', 'wallet_transaction')
  @Post('credit')
  @HttpCode(HttpStatus.OK)
  async creditWallet(@Body() dto: CreditWalletDto, @CurrentUser('id') actorId: string) {
    return this.transactionService.creditWallet(dto, actorId);
  }

  @ApiOperation({ summary: 'Debit a user wallet account with paired double-entry ledger record' })
  @ApiResponse({ status: 200, description: 'Wallet debited successfully' })
  @RequirePermissions('wallet.view')
  @AuditLogAction('TRANSACTION_CREATED', 'wallet_transaction')
  @Post('debit')
  @HttpCode(HttpStatus.OK)
  async debitWallet(@Body() dto: DebitWalletDto, @CurrentUser('id') actorId: string) {
    return this.transactionService.debitWallet(dto, actorId);
  }

  @ApiOperation({ summary: 'Transfer coins between wallets with double-entry ledger records' })
  @ApiResponse({ status: 200, description: 'Coins transferred successfully' })
  @RequirePermissions('wallet.view')
  @AuditLogAction('TRANSACTION_CREATED', 'wallet_transaction')
  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  async transferCoins(@Body() dto: TransferWalletDto, @CurrentUser('id') actorId: string) {
    return this.transactionService.transferCoins(dto, actorId);
  }
}
