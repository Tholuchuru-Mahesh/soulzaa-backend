import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WalletEntryType } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { PaginationQueryDto } from 'src/common/dto/pagination.dto';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { AdminAdjustWalletDto } from '../dto/wallet.dto';
import { WalletService } from '../services/wallet.service';

/**
 * Platform-admin wallet operations (base `admin/wallet`). Restricted to
 * ADMIN/SUPER_ADMIN. Manual adjustments are audited immutable ledger entries
 * (ADMIN_CREDIT / ADMIN_DEBIT) with the acting admin recorded as `createdBy`.
 */
@ApiTags('wallet-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/wallet')
export class WalletAdminController {
  constructor(private readonly wallet: WalletService) {}

  @Post('adjust')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually credit or debit a user wallet (audited)' })
  adjust(@CurrentUser('id') adminId: string, @Body() dto: AdminAdjustWalletDto) {
    const input = {
      userId: dto.userId,
      currency: dto.currency,
      amount: dto.amount,
      reason: WalletService.adminReason(dto.type),
      idempotencyKey: `admin-adjust:${randomUUID()}`,
      referenceType: 'admin',
      metadata: { note: dto.note, adminId },
      actorId: adminId,
    };
    return dto.type === WalletEntryType.CREDIT
      ? this.wallet.credit(input)
      : this.wallet.debit(input);
  }

  @Get(':userId/transactions')
  @ApiOperation({ summary: 'A user’s wallet transaction history' })
  transactions(@Param('userId', ParseUuidPipe) userId: string, @Query() q: PaginationQueryDto) {
    return this.wallet.listTransactions(userId, { skip: q.skip, limit: q.limit, page: q.page });
  }
}
