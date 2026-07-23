import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

@Injectable()
export class GooglePlayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(GooglePlayAdapter.name);

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    this.logger.log(`Verifying Google Play Receipt for Order '${order?.orderNumber}'`);

    // Extract or mock Google Play Purchase Token verification
    const txnId = `GPA.mock-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    return {
      isVerified: true,
      providerTxnId: txnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'USD',
      rawPayload: { provider: 'GOOGLE_PLAY', signature, receiptData },
    };
  }
}
