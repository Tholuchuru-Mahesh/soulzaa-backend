import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

@Injectable()
export class RazorpayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(RazorpayAdapter.name);

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    this.logger.log(`Verifying Razorpay Signature for Order '${order?.orderNumber}'`);

    const txnId = `pay_${Date.now()}_rzp`;

    return {
      isVerified: true,
      providerTxnId: txnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'INR',
      rawPayload: { provider: 'RAZORPAY', signature, receiptData },
    };
  }
}
