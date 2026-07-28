import { createHmac } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { RazorpayAdapter } from './razorpay.adapter';
import { StripeAdapter } from './stripe.adapter';

const configWith = (payments: Record<string, unknown>) =>
  ({ get: () => payments }) as unknown as ConfigService;

describe('RazorpayAdapter', () => {
  const SECRET = 'rzp_test_secret';
  const order = { orderNumber: 'ord-1', priceAmount: 499, currency: 'INR' };

  /** Razorpay signs `{razorpay_order_id}|{razorpay_payment_id}` with the key secret. */
  const sign = (orderId: string, paymentId: string, secret = SECRET) =>
    createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  const receipt = JSON.stringify({
    razorpay_order_id: 'order_ABC',
    razorpay_payment_id: 'pay_XYZ',
  });

  it('verifies a correctly signed receipt', async () => {
    const adapter = new RazorpayAdapter(configWith({ razorpayKeySecret: SECRET }));

    const result = await adapter.verifyReceipt(receipt, sign('order_ABC', 'pay_XYZ'), order);

    expect(result.isVerified).toBe(true);
    expect(result.providerTxnId).toBe('pay_XYZ');
  });

  it('rejects a receipt whose signature does not match', async () => {
    const adapter = new RazorpayAdapter(configWith({ razorpayKeySecret: SECRET }));

    const result = await adapter.verifyReceipt(receipt, sign('order_ABC', 'pay_TAMPERED'), order);

    expect(result.isVerified).toBe(false);
  });

  it('rejects a signature produced with a different secret', async () => {
    const adapter = new RazorpayAdapter(configWith({ razorpayKeySecret: SECRET }));

    const result = await adapter.verifyReceipt(
      receipt,
      sign('order_ABC', 'pay_XYZ', 'attacker_secret'),
      order,
    );

    expect(result.isVerified).toBe(false);
  });

  it('rejects when no signature is supplied at all', async () => {
    const adapter = new RazorpayAdapter(configWith({ razorpayKeySecret: SECRET }));

    const result = await adapter.verifyReceipt(receipt, undefined, order);

    expect(result.isVerified).toBe(false);
  });

  it('rejects rather than accepts when the provider is unconfigured', async () => {
    const adapter = new RazorpayAdapter(configWith({}));

    const result = await adapter.verifyReceipt(receipt, sign('order_ABC', 'pay_XYZ'), order);

    expect(result.isVerified).toBe(false);
    expect(result.errorMessage).toMatch(/not configured/i);
  });

  it('rejects a malformed receipt payload', async () => {
    const adapter = new RazorpayAdapter(configWith({ razorpayKeySecret: SECRET }));

    const result = await adapter.verifyReceipt('not json', 'deadbeef', order);

    expect(result.isVerified).toBe(false);
  });
});

describe('StripeAdapter', () => {
  const SECRET = 'whsec_test';
  const order = { orderNumber: 'ord-2', priceAmount: 1000, currency: 'USD' };
  const payload = JSON.stringify({ id: 'pi_123', amount: 1000, currency: 'usd' });

  /** Stripe signs `{timestamp}.{payload}` and sends `t=...,v1=...`. */
  const header = (ts: number, body: string, secret = SECRET) => {
    const v1 = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    return `t=${ts},v1=${v1}`;
  };

  const now = () => Math.floor(Date.now() / 1000);

  it('verifies a correctly signed payload', async () => {
    const adapter = new StripeAdapter(configWith({ stripeWebhookSecret: SECRET }));

    const result = await adapter.verifyReceipt(payload, header(now(), payload), order);

    expect(result.isVerified).toBe(true);
    expect(result.providerTxnId).toBe('pi_123');
  });

  it('rejects a tampered payload', async () => {
    const adapter = new StripeAdapter(configWith({ stripeWebhookSecret: SECRET }));
    const signed = header(now(), payload);

    const tampered = JSON.stringify({ id: 'pi_123', amount: 999999, currency: 'usd' });
    const result = await adapter.verifyReceipt(tampered, signed, order);

    expect(result.isVerified).toBe(false);
  });

  it('rejects a signature that is outside the replay tolerance window', async () => {
    const adapter = new StripeAdapter(configWith({ stripeWebhookSecret: SECRET }));
    const stale = now() - 60 * 60; // an hour old

    const result = await adapter.verifyReceipt(payload, header(stale, payload), order);

    expect(result.isVerified).toBe(false);
    expect(result.errorMessage).toMatch(/timestamp|tolerance|old/i);
  });

  it('rejects rather than accepts when the provider is unconfigured', async () => {
    const adapter = new StripeAdapter(configWith({}));

    const result = await adapter.verifyReceipt(payload, header(now(), payload), order);

    expect(result.isVerified).toBe(false);
    expect(result.errorMessage).toMatch(/not configured/i);
  });

  it('rejects a malformed signature header', async () => {
    const adapter = new StripeAdapter(configWith({ stripeWebhookSecret: SECRET }));

    const result = await adapter.verifyReceipt(payload, 'garbage', order);

    expect(result.isVerified).toBe(false);
  });
});
