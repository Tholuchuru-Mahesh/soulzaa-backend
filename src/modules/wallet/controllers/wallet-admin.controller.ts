import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletEntryType, WalletTxnReason } from '@prisma/client';
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
import { AdminAdjustWalletDto, WalletRecoveryDto } from '../dto/wallet.dto';
import { TransactionQueryFilterDto } from '../dto/wallet-query.dto';
import { TransactionQueryService } from '../services/transaction-query.service';
import { WalletReconciliationService } from '../services/wallet-reconciliation.service';
import { WalletTransactionService } from '../services/wallet-transaction.service';
import { WalletService } from '../services/wallet.service';

/**
 * Platform-admin wallet operations (`admin/wallet`). Manual adjustments create double-entry ledger entries.
 */
@ApiTags('wallet-admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('admin/wallet')
export class WalletAdminController {
  private readonly logger = new Logger(WalletAdminController.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly transactionService: WalletTransactionService,
    private readonly queryService: TransactionQueryService,
    private readonly reconciliation: WalletReconciliationService,
  ) {}

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually credit or debit a user wallet (audited double-entry ledger)' })
  @RequirePermissions('wallet.view')
  @AuditLogAction('TRANSACTION_CREATED', 'wallet_transaction')
  async adjust(@CurrentUser('id') adminId: string, @Body() dto: AdminAdjustWalletDto) {
    const idempotencyKey = `admin-adjust:${randomUUID()}`;

    if (dto.type === WalletEntryType.CREDIT) {
      return this.transactionService.creditWallet(
        {
          userId: dto.userId,
          amount: dto.amount,
          currency: dto.currency,
          reason: WalletTxnReason.ADMIN_CREDIT,
          idempotencyKey,
          referenceType: 'admin_adjust',
          description: dto.note ?? 'Admin Credit Adjustment',
        },
        adminId,
      );
    } else {
      return this.transactionService.debitWallet(
        {
          userId: dto.userId,
          amount: dto.amount,
          currency: dto.currency,
          reason: WalletTxnReason.ADMIN_DEBIT,
          idempotencyKey,
          referenceType: 'admin_adjust',
          description: dto.note ?? 'Admin Debit Adjustment',
        },
        adminId,
      );
    }
  }

  @Post('recovery')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile a user wallet (ledger vs balance) — report only, never auto-writes',
  })
  recovery(@CurrentUser('id') adminId: string, @Body() dto: WalletRecoveryDto) {
    this.logger.log(`admin ${adminId} triggered wallet recovery for ${dto.userId}`);
    return this.reconciliation.reconcileUser(dto.userId);
  }

  @Get(':userId/transactions')
  @ApiOperation({ summary: 'A user’s wallet transaction history' })
  @RequirePermissions('wallet.transaction.view')
  async transactions(@Param('userId') userId: string, @Query() q: TransactionQueryFilterDto) {
    const wallet = await this.walletService.getOrCreateWallet(userId);
    return this.queryService.getTransactionHistory(wallet.id, q);
  }
}
