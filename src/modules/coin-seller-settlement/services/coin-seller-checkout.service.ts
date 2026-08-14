import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { BusinessException, ERROR_CODES } from 'src/common/exceptions';
import { CoinSellerInventoryService } from './coin-seller-inventory.service';

/** Constant-time compare that tolerates unequal lengths without throwing. */
function safeEquals(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Razorpay checkout for agency (coin seller) inventory purchases.
 *
 * The money flow is deliberately three-legged, because none of the three legs
 * can be trusted alone:
 *
 *   1. `startCheckout` creates the Razorpay order server-side. The amount comes
 *      from the package row, never from the client — a client-supplied amount
 *      is a client-chosen price.
 *   2. `confirmCheckout` verifies the signature the client hands back and
 *      credits the inventory. Fast, but a client that closes the app after
 *      paying never calls it.
 *   3. The webhook (`handleWebhookEvent`) credits the same order if the client
 *      never came back. Both paths converge on one idempotent credit, so a
 *      payment confirmed twice still credits once.
 */
@Injectable()
export class CoinSellerCheckoutService {
  private readonly logger = new Logger(CoinSellerCheckoutService.name);

  private static readonly RAZORPAY_API = 'https://api.razorpay.com/v1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly inventory: CoinSellerInventoryService,
  ) {}

  private credentials(): { keyId: string; keySecret: string } {
    const payments = this.config.get('payments', { infer: true });
    const keyId = payments?.razorpayKeyId;
    const keySecret = payments?.razorpayKeySecret;

    // Fail closed. An unconfigured gateway must refuse to start a checkout
    // rather than hand the client a half-built order it can never pay.
    if (!keyId || !keySecret) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET missing)',
      );
    }
    return { keyId, keySecret };
  }

  /**
   * Creates the purchase order and its matching Razorpay order.
   *
   * Returns everything the client needs to open checkout and nothing it does
   * not: the key id is publishable, the secret never leaves the server.
   */
  async startCheckout(sellerId: string, packageId: string, idempotencyKey: string) {
    const { keyId, keySecret } = this.credentials();

    // Reuses the existing service so the replay check, package validation and
    // inventory bootstrap stay in one place.
    const order = await this.inventory.createPurchaseOrder(sellerId, packageId, idempotencyKey);

    // A replayed request returns the order it already made; if that order
    // already has a gateway reference, hand back the same one rather than
    // opening a second chargeable order for the same key.
    const existingRef = (order.metadata as { razorpayOrderId?: string } | null)?.razorpayOrderId;
    if (existingRef) {
      return this.checkoutPayload(order, existingRef, keyId);
    }

    // Razorpay takes the amount in the currency's smallest unit — paise for
    // INR. Rounded, not truncated: a package priced at x.995 would otherwise
    // be charged a paisa short of its own price.
    const amountMinor = Math.round(Number(order.priceAmount) * 100);

    const response = await fetch(`${CoinSellerCheckoutService.RAZORPAY_API}/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: amountMinor,
        currency: order.priceCurrency,
        // Our own id travels with the payment, so a webhook that arrives with
        // no client session still knows which order it settles.
        receipt: order.id,
        notes: { purchaseOrderId: order.id, sellerId, packageCode: order.packageCode },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Razorpay order creation failed (${response.status}): ${body}`);
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Could not start the payment. Please try again.',
      );
    }

    const razorpayOrder = (await response.json()) as { id: string };

    await this.prisma.coinSellerInventoryPurchaseOrder.update({
      where: { id: order.id },
      data: {
        paymentProvider: 'RAZORPAY',
        metadata: { ...((order.metadata as object) ?? {}), razorpayOrderId: razorpayOrder.id },
      },
    });

    return this.checkoutPayload(order, razorpayOrder.id, keyId);
  }

  /**
   * Creates a hosted Razorpay payment page and returns its URL.
   *
   * This is the flow where the app hands the agency off to a web page — UPI,
   * card, netbanking, whatever Razorpay offers — and never sees the payment
   * itself. Nothing comes back through the client, so the webhook is the only
   * thing that credits inventory here.
   */
  async createPaymentLink(sellerId: string, packageId: string, idempotencyKey: string) {
    const { keyId, keySecret } = this.credentials();

    const order = await this.inventory.createPurchaseOrder(sellerId, packageId, idempotencyKey);

    const meta =
      (order.metadata as { paymentLinkUrl?: string; paymentLinkId?: string } | null) ?? {};
    // A replayed request returns the link it already made rather than opening a
    // second payable page for the same money.
    if (meta.paymentLinkUrl) {
      return {
        purchaseOrderId: order.id,
        paymentUrl: meta.paymentLinkUrl,
        amount: Number(order.priceAmount),
        currency: order.priceCurrency,
        coinAmount: order.coinAmount.toString(),
        status: order.status,
      };
    }

    const amountMinor = Math.round(Number(order.priceAmount) * 100);

    const response = await fetch(`${CoinSellerCheckoutService.RAZORPAY_API}/payment_links`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      },
      body: JSON.stringify({
        amount: amountMinor,
        currency: order.priceCurrency,
        description: `${order.coinAmount.toString()} Gold Coins (${order.packageCode})`,
        // Partial payment off: a link that accepts less than the full amount
        // would fire a paid event for money that does not cover the package.
        accept_partial: false,
        // Both are our own id: reference_id survives on the link entity and
        // notes survive on the payment, so the webhook can find this order
        // whichever event shape Razorpay sends.
        reference_id: order.id,
        notes: { purchaseOrderId: order.id, sellerId },
        reminder_enable: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Razorpay payment link creation failed (${response.status}): ${body}`);
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'Could not start the payment. Please try again.',
      );
    }

    const link = (await response.json()) as { id: string; short_url: string };

    await this.prisma.coinSellerInventoryPurchaseOrder.update({
      where: { id: order.id },
      data: {
        paymentProvider: 'RAZORPAY',
        metadata: { ...meta, paymentLinkId: link.id, paymentLinkUrl: link.short_url },
      },
    });

    return {
      purchaseOrderId: order.id,
      paymentUrl: link.short_url,
      amount: Number(order.priceAmount),
      currency: order.priceCurrency,
      coinAmount: order.coinAmount.toString(),
      status: order.status,
    };
  }

  private checkoutPayload(order: any, razorpayOrderId: string, keyId: string) {
    return {
      purchaseOrderId: order.id,
      razorpayOrderId,
      // Publishable by design — this is the id the checkout page identifies the
      // merchant with.
      razorpayKeyId: keyId,
      amount: Number(order.priceAmount),
      amountMinor: Math.round(Number(order.priceAmount) * 100),
      currency: order.priceCurrency,
      coinAmount: order.coinAmount.toString(),
      packageCode: order.packageCode,
      status: order.status,
    };
  }

  /**
   * Verifies the signature the client returns from checkout, then credits.
   *
   * The signature is over `{order_id}|{payment_id}` with the key secret, so a
   * forged confirmation is not possible without the secret.
   */
  async confirmCheckout(
    sellerId: string,
    purchaseOrderId: string,
    razorpayPaymentId: string,
    razorpaySignature: string,
  ) {
    const { keySecret } = this.credentials();

    const order = await this.prisma.coinSellerInventoryPurchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    if (!order) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Purchase order not found');
    }
    // Ownership, not just existence: without this any authenticated seller
    // could confirm another seller's order into their own inventory.
    if (order.sellerId !== sellerId) {
      throw new BusinessException(
        ERROR_CODES.FORBIDDEN,
        'Purchase order belongs to another seller',
      );
    }

    const razorpayOrderId = (order.metadata as { razorpayOrderId?: string } | null)
      ?.razorpayOrderId;
    if (!razorpayOrderId) {
      throw new BusinessException(
        ERROR_CODES.VALIDATION_ERROR,
        'This order has no Razorpay checkout to confirm',
      );
    }

    const expected = createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (!safeEquals(expected, razorpaySignature)) {
      this.logger.warn(`Razorpay signature mismatch on purchase order ${purchaseOrderId}`);
      await this.prisma.coinSellerInventoryPurchaseOrder.update({
        where: { id: purchaseOrderId },
        data: {
          status: 'FAILED',
          metadata: { ...((order.metadata as object) ?? {}), signatureMismatch: true },
        },
      });
      throw new BusinessException(ERROR_CODES.VALIDATION_ERROR, 'Payment verification failed');
    }

    return this.creditVerifiedOrder(purchaseOrderId, razorpayPaymentId, sellerId);
  }

  /**
   * Credits a paid order exactly once.
   *
   * Both the client confirmation and the webhook land here, so the already-
   * credited check is the thing that stops a double credit — not the caller.
   */
  async creditVerifiedOrder(purchaseOrderId: string, providerTxnRef: string, actorId: string) {
    const order = await this.prisma.coinSellerInventoryPurchaseOrder.findUnique({
      where: { id: purchaseOrderId },
    });
    if (!order) {
      throw new BusinessException(ERROR_CODES.NOT_FOUND, 'Purchase order not found');
    }
    if (order.status === 'INVENTORY_CREDITED') {
      return order;
    }

    await this.prisma.coinSellerInventoryPurchaseOrder.update({
      where: { id: purchaseOrderId },
      data: { status: 'PAYMENT_VERIFIED', providerTxnRef },
    });

    // Reuses the existing approval path, which sources the coins from the
    // treasury and writes the audit row inside one transaction.
    return this.inventory.approvePurchaseOrder(purchaseOrderId, actorId);
  }

  /**
   * Razorpay webhook. Authoritative when the client never came back.
   *
   * The raw body is required: the signature is over the exact bytes Razorpay
   * sent, so re-serialising the parsed object would change them and every
   * event would fail verification.
   */
  async handleWebhookEvent(rawBody: Buffer, signature: string | undefined) {
    const secret = this.config.get('payments', { infer: true })?.razorpayWebhookSecret;

    if (!secret) {
      // Fail closed: an unconfigured webhook must not credit inventory on an
      // anonymous POST.
      this.logger.error('Razorpay webhook rejected: RAZORPAY_WEBHOOK_SECRET is unset');
      throw new BusinessException(ERROR_CODES.FORBIDDEN, 'Webhook is not configured');
    }
    if (!signature) {
      throw new BusinessException(ERROR_CODES.FORBIDDEN, 'Missing webhook signature');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!safeEquals(expected, signature)) {
      this.logger.warn('Razorpay webhook rejected: signature mismatch');
      throw new BusinessException(ERROR_CODES.FORBIDDEN, 'Invalid webhook signature');
    }

    const event = JSON.parse(rawBody.toString('utf8')) as RazorpayEvent;

    // payment_link.paid is what the hosted-page flow sends; payment.captured is
    // what Checkout sends. Both mean the same thing to us.
    if (event.event !== 'payment.captured' && event.event !== 'payment_link.paid') {
      // Everything else is acknowledged and ignored: returning an error would
      // make Razorpay retry an event we will never act on.
      return { handled: false, reason: `Ignored event '${event.event}'` };
    }

    const payment = event.payload?.payment?.entity;
    if (!payment?.id) {
      this.logger.warn(`Razorpay webhook: ${event.event} carried no payment entity`);
      return { handled: false, reason: 'No payment entity' };
    }

    const purchaseOrderId = await this.resolvePurchaseOrderId(event);
    if (!purchaseOrderId) {
      this.logger.warn(`Razorpay webhook: could not match ${payment.id} to a purchase order`);
      return { handled: false, reason: 'No matching purchase order' };
    }

    // What was actually paid has to cover what the package costs. A signature
    // proves Razorpay sent the event, not that the money matches the order —
    // without this, any captured payment credits the full package.
    const paidCheck = await this.assertAmountCovers(purchaseOrderId, payment);
    if (!paidCheck.ok) {
      this.logger.error(
        `Razorpay webhook: ${payment.id} paid ${paidCheck.paidMinor} ` +
          `${payment.currency ?? '?'} against an order expecting ${paidCheck.expectedMinor}`,
      );
      return { handled: false, reason: 'Paid amount does not cover the order' };
    }

    const order = await this.creditVerifiedOrder(purchaseOrderId, payment.id, 'RAZORPAY_WEBHOOK');
    return { handled: true, purchaseOrderId, status: (order as { status?: string }).status };
  }

  /**
   * Checks the captured amount against the order's own price.
   *
   * Compared in minor units against the stored price, never against a figure
   * from the event, and the currency has to match too — 40,000 JPY is not
   * 40,000 INR.
   */
  private async assertAmountCovers(
    purchaseOrderId: string,
    payment: { amount?: number; currency?: string },
  ): Promise<{ ok: boolean; paidMinor: number; expectedMinor: number }> {
    const order = await this.prisma.coinSellerInventoryPurchaseOrder.findUnique({
      where: { id: purchaseOrderId },
      select: { priceAmount: true, priceCurrency: true },
    });

    const expectedMinor = order ? Math.round(Number(order.priceAmount) * 100) : Number.NaN;
    const paidMinor = payment.amount ?? 0;

    const currencyMatches =
      !!order && (payment.currency ?? order.priceCurrency) === order.priceCurrency;

    return {
      ok: !!order && currencyMatches && paidMinor >= expectedMinor,
      paidMinor,
      expectedMinor,
    };
  }

  /**
   * Finds our purchase order for an incoming payment.
   *
   * Three routes, because Razorpay populates different fields depending on how
   * the money was taken. The first version of this read `payment.notes` alone,
   * which is empty for a payment made against an order whose notes we set —
   * Razorpay does not copy order notes onto the payment — so every real webhook
   * would have been declined while the unit test passed.
   */
  private async resolvePurchaseOrderId(event: RazorpayEvent): Promise<string | null> {
    const payment = event.payload?.payment?.entity;
    const link = event.payload?.payment_link?.entity;

    // 1. Notes we set on the payment link, which do reach the payment.
    const fromNotes = payment?.notes?.purchaseOrderId ?? link?.notes?.purchaseOrderId;
    if (fromNotes) return fromNotes;

    // 2. The payment link's reference_id — our own order id.
    if (link?.reference_id) return link.reference_id;

    // 3. The gateway order id, matched against what we stored when we created
    //    it. This is the route that works for the Checkout flow.
    if (payment?.order_id) {
      const match = await this.prisma.coinSellerInventoryPurchaseOrder.findFirst({
        where: { metadata: { path: ['razorpayOrderId'], equals: payment.order_id } },
        select: { id: true },
      });
      if (match) return match.id;
    }

    return null;
  }
}

interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        amount?: number;
        currency?: string;
        order_id?: string;
        notes?: { purchaseOrderId?: string };
      };
    };
    payment_link?: {
      entity?: {
        reference_id?: string;
        notes?: { purchaseOrderId?: string };
      };
    };
  };
}
