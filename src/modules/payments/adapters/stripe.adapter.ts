import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';
import { safeEquals } from './razorpay.adapter';

/**
 * How far a signature timestamp may drift before it is refused. Stripe's own
 * default — it bounds how long a captured payload stays replayable.
 */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Stripe payload verification.
 *
 * Stripe signs `{timestamp}.{payload}` with the endpoint's signing secret and
 * sends it as `t=<ts>,v1=<hex>`. Verifying the signature locally proves both that
 * Stripe sent the payload and that nobody altered the amount in transit.
 */
@Injectable()
export class StripeAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(StripeAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    const secret = this.config.get('payments', { infer: true })?.stripeWebhookSecret;
    if (!secret) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Stripe is not configured (STRIPE_WEBHOOK_SECRET missing)',
      };
    }

    if (!signature) {
      return { isVerified: false, providerTxnId: '', errorMessage: 'Missing Stripe signature' };
    }

    const parts = new Map(
      signature
        .split(',')
        .map((part) => part.split('='))
        .filter((pair): pair is [string, string] => pair.length === 2)
        .map(([k, v]) => [k.trim(), v.trim()]),
    );

    const timestamp = Number(parts.get('t'));
    const provided = parts.get('v1');
    if (!Number.isFinite(timestamp) || !provided) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Malformed Stripe signature header',
      };
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > TOLERANCE_SECONDS) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: `Stripe signature timestamp is outside the ${TOLERANCE_SECONDS}s tolerance window`,
      };
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${receiptData}`)
      .digest('hex');
    if (!safeEquals(expected, provided)) {
      this.logger.warn(`Stripe signature mismatch for order '${order?.orderNumber}'`);
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Stripe signature verification failed',
      };
    }

    let parsed: { id?: string; amount?: number; currency?: string };
    try {
      parsed = JSON.parse(receiptData);
    } catch {
      return { isVerified: false, providerTxnId: '', errorMessage: 'Malformed Stripe payload' };
    }

    if (!parsed.id) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Stripe payload is missing a payment intent id',
      };
    }

    return {
      isVerified: true,
      providerTxnId: parsed.id,
      amountVerified: parsed.amount,
      currencyVerified: parsed.currency?.toUpperCase(),
      rawPayload: { provider: 'STRIPE', id: parsed.id },
    };
  }
}
