import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { ListWalletTransactionsDto } from '../dto/wallet.dto';
import { WalletService } from '../services/wallet.service';

/**
 * User-facing wallet REST surface (base `wallet`). JWT-guarded globally. Read
 * only — all mutations flow through the economy features (recharge, gifts) or
 * admin adjustments, never a direct user-driven balance write.
 */
@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('balance')
  @ApiOperation({ summary: 'Current gold / free / earnings balances' })
  balance(@CurrentUser('id') userId: string) {
    return this.wallet.getBalance(userId);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'Wallet transaction history (paginated)' })
  transactions(@CurrentUser('id') userId: string, @Query() q: ListWalletTransactionsDto) {
    return this.wallet.listTransactions(userId, {
      skip: q.skip,
      limit: q.limit,
      page: q.page,
      currency: q.currency,
    });
  }
}
