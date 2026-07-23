import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/authorization/decorators/authorization.decorators';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { TransactionQueryFilterDto } from '../dto/wallet-query.dto';
import { BalanceService } from '../services/balance.service';
import { TransactionQueryService } from '../services/transaction-query.service';
import { WalletService } from '../services/wallet.service';

/**
 * User-facing wallet REST surface (`wallet`). JWT-guarded. Read-only balance & transaction history.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly balanceService: BalanceService,
    private readonly queryService: TransactionQueryService,
  ) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current gold / free / earnings balances & projection' })
  async balance(@CurrentUser('id') userId: string) {
    const wallet = await this.walletService.getOrCreateWallet(userId);
    return this.balanceService.getBalanceProjection(wallet.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Wallet transaction history (paginated)' })
  async transactions(@CurrentUser('id') userId: string, @Query() q: TransactionQueryFilterDto) {
    const wallet = await this.walletService.getOrCreateWallet(userId);
    return this.queryService.getTransactionHistory(wallet.id, q);
  }
}
