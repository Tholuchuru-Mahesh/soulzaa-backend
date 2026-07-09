import { Global, Module } from '@nestjs/common';
import { WalletAdminController } from './controllers/wallet-admin.controller';
import { WalletController } from './controllers/wallet.controller';
import { WALLET_SERVICE } from './interfaces/wallet.service.interface';
import { WalletRepository } from './repositories/wallet.repository';
import { WalletService } from './services/wallet.service';

/**
 * Wallet domain — gold/free/earnings balances and the immutable wallet
 * transaction ledger. The economy authority: every coin movement is an
 * append-only, idempotent ledger entry applied under a per-user lock inside a DB
 * transaction, and balances never go negative.
 *
 * @Global so economy features (gifts, VIP, treasure boxes, games, payments)
 * resolve WALLET_SERVICE by token without importing this module — cross-module
 * access only via `interfaces/` or the EVENT_BUS.
 */
@Global()
@Module({
  controllers: [WalletController, WalletAdminController],
  providers: [
    WalletRepository,
    WalletService,
    { provide: WALLET_SERVICE, useExisting: WalletService },
  ],
  exports: [WALLET_SERVICE, WalletService],
})
export class WalletModule {}
