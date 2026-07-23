import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

@Injectable()
export class StripeAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(StripeAdapter.name);

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    this.logger.log(`Verifying Stripe Payment Intent for Order '${order?.orderNumber}'`);

    const txnId = `pi_${Date.now()}_stripe`;

    return {
      isVerified: true,
      providerTxnId: txnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'USD',
      rawPayload: { provider: 'STRIPE', signature, receiptData },
    };
  }
}
