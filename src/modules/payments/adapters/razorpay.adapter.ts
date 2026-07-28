import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IPaymentProviderAdapter, VerificationResult } from './payment-provider.interface';

/** Constant-time compare that tolerates unequal lengths without throwing. */
export function safeEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Razorpay receipt verification.
 *
 * Razorpay signs `{razorpay_order_id}|{razorpay_payment_id}` with the account's
 * key secret, so a payment verifies entirely offline — no API call, and no way to
 * forge one without the secret.
 */
@Injectable()
export class RazorpayAdapter implements IPaymentProviderAdapter {
  private readonly logger = new Logger(RazorpayAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async verifyReceipt(
    receiptData: string,
    signature?: string,
    order?: any,
  ): Promise<VerificationResult> {
    const secret = this.config.get('payments', { infer: true })?.razorpayKeySecret;
    if (!secret) {
      // Fail closed: an unconfigured provider must never approve a purchase.
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Razorpay is not configured (RAZORPAY_KEY_SECRET missing)',
      };
    }

    if (!signature) {
      return { isVerified: false, providerTxnId: '', errorMessage: 'Missing Razorpay signature' };
    }

    let parsed: { razorpay_order_id?: string; razorpay_payment_id?: string };
    try {
      parsed = JSON.parse(receiptData);
    } catch {
      return { isVerified: false, providerTxnId: '', errorMessage: 'Malformed Razorpay receipt' };
    }

    const orderId = parsed.razorpay_order_id;
    const paymentId = parsed.razorpay_payment_id;
    if (!orderId || !paymentId) {
      return {
        isVerified: false,
        providerTxnId: '',
        errorMessage: 'Receipt is missing razorpay_order_id or razorpay_payment_id',
      };
    }

    const expected = createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    if (!safeEquals(expected, signature)) {
      this.logger.warn(`Razorpay signature mismatch for order '${order?.orderNumber}'`);
      return {
        isVerified: false,
        providerTxnId: paymentId,
        errorMessage: 'Razorpay signature verification failed',
      };
    }

    return {
      isVerified: true,
      providerTxnId: paymentId,
      amountVerified: order ? Number(order.priceAmount) : undefined,
      currencyVerified: order?.currency,
      rawPayload: { provider: 'RAZORPAY', orderId, paymentId },
    };
  }
}
