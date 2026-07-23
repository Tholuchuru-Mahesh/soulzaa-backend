import { Injectable, Logger } from '@nestjs/common';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

@Injectable()
export class MockGatewayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(MockGatewayAdapter.name);

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    this.logger.log(`Verifying Mock Gateway Receipt for Order '${order?.orderNumber}'`);

    const txnId = `mock_txn_${Date.now()}`;

    return {
      isVerified: true,
      providerTxnId: txnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'USD',
      rawPayload: { provider: 'MOCK_GATEWAY', signature, receiptData },
    };
  }
}
