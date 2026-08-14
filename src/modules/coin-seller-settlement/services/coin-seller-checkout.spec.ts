import { createHmac } from 'node:crypto';
import { CoinSellerCheckoutService } from './coin-seller-checkout.service';

const KEY_ID = 'rzp_test_key';
const KEY_SECRET = 'rzp_test_secret';
const WEBHOOK_SECRET = 'whsec_test';
const SELLER = 'seller-1';

function build(overrides: { payments?: Record<string, unknown> } = {}) {
  const prisma: any = {
    coinSellerInventoryPurchaseOrder: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const config: any = {
    get: jest.fn().mockReturnValue({
      razorpayKeyId: KEY_ID,
      razorpayKeySecret: KEY_SECRET,
      razorpayWebhookSecret: WEBHOOK_SECRET,
      ...(overrides.payments ?? {}),
    }),
  };
  const inventory: any = {
    createPurchaseOrder: jest.fn(),
    approvePurchaseOrder: jest.fn().mockResolvedValue({ status: 'INVENTORY_CREDITED' }),
  };

  return {
    service: new CoinSellerCheckoutService(prisma, config, inventory),
    prisma,
    inventory,
  };
}

const ORDER = {
  id: 'po-1',
  sellerId: SELLER,
  priceAmount: '100.00',
  priceCurrency: 'INR',
  coinAmount: BigInt(275),
  packageCode: 'AGENCY_GOLD_100',
  status: 'PENDING_PAYMENT',
  metadata: null,
};

describe('CoinSellerCheckoutService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('startCheckout', () => {
    it('charges the package price, never a client-supplied one', async () => {
      const { service, inventory } = build();
      inventory.createPurchaseOrder.mockResolvedValue(ORDER);

      const fetchMock = jest
        .spyOn(globalThis, 'fetch' as any)
        .mockResolvedValue({ ok: true, json: async () => ({ id: 'order_rzp1' }) } as any);

      await service.startCheckout(SELLER, 'pkg-1', 'idem-key-1234');

      const body = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
      // 100.00 INR → 10000 paise, taken from the order row.
      expect(body.amount).toBe(10000);
      expect(body.currency).toBe('INR');
      // Our id travels with the payment so a webhook can find its order.
      expect(body.notes.purchaseOrderId).toBe('po-1');
    });

    it('reuses the gateway order on a replayed request', async () => {
      const { service, inventory } = build();
      inventory.createPurchaseOrder.mockResolvedValue({
        ...ORDER,
        metadata: { razorpayOrderId: 'order_existing' },
      });
      const fetchMock = jest.spyOn(globalThis, 'fetch' as any);

      const result = await service.startCheckout(SELLER, 'pkg-1', 'idem-key-1234');

      expect(result.razorpayOrderId).toBe('order_existing');
      // No second chargeable order for the same key.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses to start when the gateway is unconfigured', async () => {
      const { service } = build({ payments: { razorpayKeyId: undefined } });
      await expect(service.startCheckout(SELLER, 'pkg-1', 'idem-key-1234')).rejects.toThrow(
        /not configured/i,
      );
    });
  });

  describe('confirmCheckout', () => {
    const withGatewayOrder = { ...ORDER, metadata: { razorpayOrderId: 'order_rzp1' } };

    function signatureFor(orderId: string, paymentId: string, secret = KEY_SECRET) {
      return createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
    }

    it('credits on a genuine signature', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(withGatewayOrder);

      await service.confirmCheckout(SELLER, 'po-1', 'pay_1', signatureFor('order_rzp1', 'pay_1'));

      expect(inventory.approvePurchaseOrder).toHaveBeenCalledWith('po-1', SELLER);
    });

    it('rejects a forged signature and credits nothing', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(withGatewayOrder);

      await expect(
        service.confirmCheckout(
          SELLER,
          'po-1',
          'pay_1',
          signatureFor('order_rzp1', 'pay_1', 'wrong-secret'),
        ),
      ).rejects.toThrow(/verification failed/i);

      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it("refuses another seller's order", async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue({
        ...withGatewayOrder,
        sellerId: 'someone-else',
      });

      await expect(
        service.confirmCheckout(SELLER, 'po-1', 'pay_1', signatureFor('order_rzp1', 'pay_1')),
      ).rejects.toThrow(/another seller/i);

      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it('credits an already-credited order only once', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue({
        ...withGatewayOrder,
        status: 'INVENTORY_CREDITED',
      });

      await service.confirmCheckout(SELLER, 'po-1', 'pay_1', signatureFor('order_rzp1', 'pay_1'));

      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });
  });

  describe('handleWebhookEvent', () => {
    /** A payment link paid in full — the hosted-page flow. */
    function linkPaid(referenceId?: string, amountMinor = 10000) {
      return Buffer.from(
        JSON.stringify({
          event: 'payment_link.paid',
          payload: {
            payment: { entity: { id: 'pay_1', amount: amountMinor, currency: 'INR' } },
            payment_link: { entity: { reference_id: referenceId } },
          },
        }),
      );
    }

    /**
     * Checkout's payload as Razorpay actually sends it: the payment carries an
     * order_id and NO notes. Order notes are not copied onto the payment.
     */
    function paymentCaptured(orderId?: string, amountMinor = 10000) {
      return Buffer.from(
        JSON.stringify({
          event: 'payment.captured',
          payload: {
            payment: {
              entity: { id: 'pay_1', amount: amountMinor, currency: 'INR', order_id: orderId },
            },
          },
        }),
      );
    }

    function payload(event: string, purchaseOrderId?: string) {
      return Buffer.from(
        JSON.stringify({
          event,
          payload: {
            payment: {
              entity: { id: 'pay_1', amount: 10000, currency: 'INR', notes: { purchaseOrderId } },
            },
          },
        }),
      );
    }

    it('credits a captured payment', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(ORDER);

      const body = payload('payment.captured', 'po-1');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(true);
      expect(inventory.approvePurchaseOrder).toHaveBeenCalledWith('po-1', 'RAZORPAY_WEBHOOK');
    });

    it('rejects an unsigned call', async () => {
      const { service, inventory } = build();
      await expect(
        service.handleWebhookEvent(payload('payment.captured', 'po-1'), undefined),
      ).rejects.toThrow(/signature/i);
      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it('rejects a body that does not match its signature', async () => {
      const { service, inventory } = build();
      const signed = payload('payment.captured', 'po-1');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(signed).digest('hex');
      // Same signature, different bytes — a tampered amount or order id.
      const tampered = payload('payment.captured', 'po-999');

      await expect(service.handleWebhookEvent(tampered, signature)).rejects.toThrow(/signature/i);
      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it('fails closed when no webhook secret is configured', async () => {
      const { service } = build({ payments: { razorpayWebhookSecret: undefined } });
      const body = payload('payment.captured', 'po-1');
      await expect(service.handleWebhookEvent(body, 'anything')).rejects.toThrow(/not configured/i);
    });

    it('credits a paid payment link, matched by reference_id', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(ORDER);

      const body = linkPaid('po-1');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(true);
      expect(inventory.approvePurchaseOrder).toHaveBeenCalledWith('po-1', 'RAZORPAY_WEBHOOK');
    });

    it('matches a captured payment by its gateway order id when notes are absent', async () => {
      const { service, prisma, inventory } = build();
      // Razorpay sends no notes on a payment made against an order, so the only
      // link back is order_id → the reference we stored at checkout.
      prisma.coinSellerInventoryPurchaseOrder.findFirst.mockResolvedValue({ id: 'po-1' });
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(ORDER);

      const body = paymentCaptured('order_rzp1');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(true);
      expect(inventory.approvePurchaseOrder).toHaveBeenCalledWith('po-1', 'RAZORPAY_WEBHOOK');
    });

    it('credits nothing when the payment is short of the package price', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(ORDER);

      // ₹1 against a ₹100 package.
      const body = linkPaid('po-1', 100);
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(false);
      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it('credits nothing when the payment is in another currency', async () => {
      const { service, prisma, inventory } = build();
      prisma.coinSellerInventoryPurchaseOrder.findUnique.mockResolvedValue(ORDER);

      const body = Buffer.from(
        JSON.stringify({
          event: 'payment_link.paid',
          payload: {
            payment: { entity: { id: 'pay_1', amount: 10000, currency: 'JPY' } },
            payment_link: { entity: { reference_id: 'po-1' } },
          },
        }),
      );
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(false);
      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });

    it('acknowledges events it does not act on', async () => {
      const { service, inventory } = build();
      const body = payload('payment.failed', 'po-1');
      const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

      const result = await service.handleWebhookEvent(body, signature);

      expect(result.handled).toBe(false);
      expect(inventory.approvePurchaseOrder).not.toHaveBeenCalled();
    });
  });
});
