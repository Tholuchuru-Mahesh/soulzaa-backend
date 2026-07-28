import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

/**
 * Test-only gateway that approves any receipt.
 *
 * Gated behind `PAYMENTS_ALLOW_MOCK_GATEWAY`, which defaults to false: reaching
 * this adapter is an unauthenticated path to crediting a wallet, so in any
 * environment that has not explicitly opted in it must refuse rather than mint
 * coins for a made-up receipt.
 */
@Injectable()
export class MockGatewayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(MockGatewayAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    const allowed = this.config.get('payments', { infer: true })?.allowMockGateway;
    if (!allowed) {
      this.logger.warn(
        `Refused MOCK_GATEWAY verification for order '${order?.orderNumber}' — ` +
          'set PAYMENTS_ALLOW_MOCK_GATEWAY=true to enable it in non-production environments',
      );
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Mock payment gateway is disabled',
      };
    }

    this.logger.log(`Mock gateway approving order '${order?.orderNumber}'`);
    return {
      isVerified: true,
      providerTxnId: `mock_txn_${order?.id ?? order?.orderNumber ?? 'unknown'}`,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency ?? 'USD',
      rawPayload: { provider: 'MOCK_GATEWAY', signature, receiptData },
    };
  }
}
