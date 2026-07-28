import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

const PRODUCTION_HOST = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_HOST = 'https://sandbox.itunes.apple.com/verifyReceipt';

/** Apple returns 21007 when a sandbox receipt is sent to the production host. */
const SANDBOX_RECEIPT_ON_PRODUCTION = 21007;
/** ...and 21008 for the converse. */
const PRODUCTION_RECEIPT_ON_SANDBOX = 21008;

interface AppleVerifyResponse {
  status: number;
  receipt?: {
    in_app?: Array<{ transaction_id?: string; product_id?: string }>;
  };
  latest_receipt_info?: Array<{ transaction_id?: string; product_id?: string }>;
}

/**
 * Apple In-App Purchase verification.
 *
 * Unlike the other providers this cannot be settled offline — an App Store
 * receipt is opaque and only Apple can attest to it, so this posts to
 * /verifyReceipt with the app's shared secret.
 *
 * Apple's guidance is to try production first and retry against sandbox on status
 * 21007, because a single build's receipts can come from either and the host that
 * rejects one accepts the other.
 */
@Injectable()
export class AppleIapAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(AppleIapAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async verifyReceipt(
    receiptData: string,
    _signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    const payments = this.config.get('payments', { infer: true });
    const sharedSecret = payments?.appleSharedSecret;
    if (!sharedSecret) {
      // Fail closed: an unconfigured provider must never approve a purchase.
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Apple IAP is not configured (APPLE_IAP_SHARED_SECRET missing)',
      };
    }

    const startHost = payments?.appleUseSandbox ? SANDBOX_HOST : PRODUCTION_HOST;

    try {
      let response = await this.post(startHost, receiptData, sharedSecret);

      if (response.status === SANDBOX_RECEIPT_ON_PRODUCTION) {
        response = await this.post(SANDBOX_HOST, receiptData, sharedSecret);
      } else if (response.status === PRODUCTION_RECEIPT_ON_SANDBOX) {
        response = await this.post(PRODUCTION_HOST, receiptData, sharedSecret);
      }

      if (response.status !== 0) {
        return {
          isVerified: false,
          providerTxnId: '',
          errorMessage: `Apple rejected the receipt (status ${response.status})`,
        };
      }

      const entry = response.latest_receipt_info?.[0] ?? response.receipt?.in_app?.[0];
      const transactionId = entry?.transaction_id;
      if (!transactionId) {
        return {
          isVerified: false,
          providerTxnId: '',
          errorMessage: 'Apple receipt contains no transaction',
        };
      }

      return {
        isVerified: true,
        providerTxnId: transactionId,
        amountVerified: order ? Number(order.priceAmount) : undefined,
        currencyVerified: order?.currency,
        rawPayload: { provider: 'APPLE_IAP', productId: entry?.product_id, transactionId },
      };
    } catch (err) {
      // A network failure is not a valid purchase — never fall through to success.
      this.logger.error(`Apple receipt verification failed: ${(err as Error).message}`);
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: `Apple receipt verification failed: ${(err as Error).message}`,
      };
    }
  }

  private async post(
    url: string,
    receiptData: string,
    password: string,
  ): Promise<AppleVerifyResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'receipt-data': receiptData,
        password,
        'exclude-old-transactions': true,
      }),
    });

    if (!res.ok) {
      throw new Error(`Apple returned HTTP ${res.status}`);
    }
    return (await res.json()) as AppleVerifyResponse;
  }
}
