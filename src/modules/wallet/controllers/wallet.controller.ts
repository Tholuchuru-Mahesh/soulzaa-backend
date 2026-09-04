import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { CurrentUser } from 'src/modules/authorization/decorators/authorization.decorators';
import { TransactionQueryFilterDto } from '../dto/wallet-query.dto';
import { WalletEarningsQueryDto, WalletHistoryQueryDto, WalletRewardsQueryDto } from '../dto/wallet.dto';
import { BalanceService } from '../services/balance.service';
import { TransactionQueryService } from '../services/transaction-query.service';
import { WalletReadService } from '../services/wallet-read.service';
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
    private readonly read: WalletReadService,
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

  @Get('earnings')
  @ApiOperation({ summary: 'Host/creator earnings summary (settlement-ready = EARNINGS balance)' })
  earnings(@CurrentUser('id') userId: string, @Query() q?: WalletEarningsQueryDto) {
    return this.read.getEarnings(userId, q?.roomType);
  }

  @Get('rewards')
  @ApiOperation({ summary: 'Rewards received (treasure / PK / event), paginated' })
  rewards(@CurrentUser('id') userId: string, @Query() q: WalletRewardsQueryDto) {
    return this.read.getRewards(userId, q.page, q.limit);
  }

  @Get('history')
  @ApiOperation({ summary: 'Unified wallet ledger history with filters (paginated)' })
  history(@CurrentUser('id') userId: string, @Query() q: WalletHistoryQueryDto) {
    return this.read.getHistory(
      userId,
      { currency: q.currency, reason: q.reason },
      q.page,
      q.limit,
    );
  }
}
