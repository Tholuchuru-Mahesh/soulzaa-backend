import { Injectable, Logger } from '@nestjs/common';
import { GooglePlayApiClient } from './google-play-api.client';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

/**
 * Google Play purchase verification via the Android Publisher API.
 *
 * This replaced an offline signature check against the Play licence key. A
 * signature proves the purchase JSON came from Google, but says nothing about
 * whether the purchase was later refunded, is still pending, or has already been
 * consumed — all of which the API reports. The signature path was removed rather
 * than kept as a fallback: a fallback that approves purchases the API would
 * reject is a hole, not a safety net.
 *
 * `receiptData` carries the Play purchase token. `signature` is unused here.
 */
@Injectable()
export class GooglePlayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(GooglePlayAdapter.name);

  constructor(private readonly apiClient: GooglePlayApiClient) {}

  async verifyReceipt(
    receiptData: string,
    _signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    if (!this.apiClient.isConfigured()) {
      // Fail closed: an unconfigured provider must never approve a purchase.
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage:
          'Google Play is not configured (GOOGLE_PLAY_PACKAGE_NAME or GOOGLE_PLAY_SERVICE_ACCOUNT_JSON missing)',
      };
    }

    const productId = order?.package?.googleProductId;
    if (!productId) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Order package has no googleProductId; it cannot be sold on Android',
      };
    }

    try {
      const purchase = await this.apiClient.getProductPurchase(productId, receiptData);

      if (!purchase.orderId) {
        return {
          isVerified: false,
          providerTxnId: '',
          errorMessage: 'Google Play response is missing orderId',
        };
      }

      return {
        isVerified: true,
        providerTxnId: purchase.orderId,
        productId: purchase.productId,
        purchaseState: purchase.purchaseState,
        consumptionState: purchase.consumptionState,
        externalAccountId: purchase.obfuscatedExternalAccountId,
        amountVerified: order ? Number(order.priceAmount) : undefined,
        currencyVerified: order?.currency,
        rawPayload: { provider: 'GOOGLE_PLAY', ...purchase },
      };
    } catch (err) {
      // A network or API failure is not a valid purchase — never fall through.
      const message = (err as Error).message;
      this.logger.error(
        `Google Play verification failed for order '${order?.orderNumber}': ${message}`,
      );
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: `Google Play verification failed: ${message}`,
      };
    }
  }
}
