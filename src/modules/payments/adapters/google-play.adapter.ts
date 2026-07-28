import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, createVerify } from 'node:crypto';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

/**
 * Google Play purchase verification.
 *
 * Play signs the purchase JSON with the app's private key and the client sends
 * the base64 `INAPP_DATA_SIGNATURE` alongside it. Verifying against the app's
 * public licence key (Play Console → Monetisation setup) proves the purchase is
 * genuine without an Android Publisher API round trip, so no OAuth service
 * account sits on the request path.
 */
@Injectable()
export class GooglePlayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(GooglePlayAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    const licenseKey = this.config.get('payments', { infer: true })?.googlePlayLicenseKey;
    if (!licenseKey) {
      // Fail closed: an unconfigured provider must never approve a purchase.
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Google Play is not configured (GOOGLE_PLAY_LICENSE_KEY missing)',
      };
    }

    if (!signature) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Missing Google Play purchase signature',
      };
    }

    let verified: boolean;
    try {
      // The licence key is a bare base64 DER SPKI blob; wrap it as PEM.
      const pem = [
        '-----BEGIN PUBLIC KEY-----',
        ...(licenseKey.match(/.{1,64}/g) ?? []),
        '-----END PUBLIC KEY-----',
      ].join('\n');
      const key = createPublicKey(pem);

      // Play signs the exact purchase JSON with SHA1withRSA.
      verified = createVerify('RSA-SHA1')
        .update(receiptData, 'utf8')
        .verify(key, Buffer.from(signature, 'base64'));
    } catch (err) {
      this.logger.warn(`Google Play signature check errored: ${(err as Error).message}`);
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: `Google Play signature could not be checked: ${(err as Error).message}`,
      };
    }

    if (!verified) {
      this.logger.warn(`Google Play signature mismatch for order '${order?.orderNumber}'`);
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Google Play signature verification failed',
      };
    }

    let parsed: { orderId?: string; purchaseToken?: string; productId?: string };
    try {
      parsed = JSON.parse(receiptData);
    } catch {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Malformed Google Play purchase payload',
      };
    }

    // orderId identifies the transaction; purchaseToken is the fallback identity.
    const providerTxnId = parsed.orderId ?? parsed.purchaseToken;
    if (!providerTxnId) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Google Play payload is missing orderId and purchaseToken',
      };
    }

    return {
      isVerified: true,
      providerTxnId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency,
      rawPayload: { provider: 'GOOGLE_PLAY', productId: parsed.productId, orderId: parsed.orderId },
    };
  }
}
