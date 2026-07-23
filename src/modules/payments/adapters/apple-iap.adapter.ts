import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

@Injectable()
export class AppleIapAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(AppleIapAdapter.name);

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    this.logger.log(`Verifying Apple IAP Receipt for Order '${order?.orderNumber}'`);

    const txnId = `APL.mock-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    return {
      isVerified: true,
      providerTxnId: txnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'USD',
      rawPayload: { provider: 'APPLE_IAP', signature, receiptData },
    };
  }
}
