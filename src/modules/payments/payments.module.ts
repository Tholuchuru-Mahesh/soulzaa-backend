import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { TreasuryModule } from 'src/modules/treasury/treasury.module';
import { WalletModule } from 'src/modules/wallet/wallet.module';
import { AppleIapAdapter } from './adapters/apple-iap.adapter';
import { GooglePlayApiClient } from './adapters/google-play-api.client';
import { GooglePlayAdapter } from './adapters/google-play.adapter';
import { MockGatewayAdapter } from './adapters/mock-gateway.adapter';
import { PaymentProviderFactory } from './adapters/payment-provider.factory';
import { RazorpayAdapter } from './adapters/razorpay.adapter';
import { StripeAdapter } from './adapters/stripe.adapter';
import { CoinPurchaseController } from './controllers/coin-purchase.controller';
import { GoogleRtdnController } from './controllers/google-rtdn.controller';
import { PurchaseReconciliationScheduler } from './schedulers/purchase-reconciliation.scheduler';
import { CoinPackageService } from './services/coin-package.service';
import { GoogleRtdnService } from './services/google-rtdn.service';
import { PurchaseAuditService } from './services/purchase-audit.service';
import { PurchaseOrderService } from './services/purchase-order.service';
import { PurchaseQueryService } from './services/purchase-query.service';
import { PurchaseReconciliationService } from './services/purchase-reconciliation.service';
import { ReceiptVerificationService } from './services/receipt-verification.service';

import { CoinOffersModule } from 'src/modules/coin-offers/coin-offers.module';

@Global()
@Module({
  imports: [PrismaModule, PlatformConfigurationModule, TreasuryModule, WalletModule, CoinOffersModule],
  controllers: [CoinPurchaseController, GoogleRtdnController],
  providers: [
    GooglePlayApiClient,
    GooglePlayAdapter,
    AppleIapAdapter,
    RazorpayAdapter,
    StripeAdapter,
    MockGatewayAdapter,
    PaymentProviderFactory,
    PurchaseAuditService,
    CoinPackageService,
    PurchaseOrderService,
    ReceiptVerificationService,
    PurchaseQueryService,
    PurchaseReconciliationService,
    PurchaseReconciliationScheduler,
    GoogleRtdnService,
  ],
  exports: [
    GooglePlayApiClient,
    PaymentProviderFactory,
    PurchaseAuditService,
    CoinPackageService,
    PurchaseOrderService,
    ReceiptVerificationService,
    PurchaseQueryService,
    PurchaseReconciliationService,
    GoogleRtdnService,
  ],
})
export class PaymentsModule {}
