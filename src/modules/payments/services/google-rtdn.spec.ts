import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { GoogleRtdnService } from './google-rtdn.service';

/**
 * Play refunds arrive here. The properties that matter: a completed order is
 * reversed exactly once no matter how many times Pub/Sub redelivers, an
 * unrecognised notification is swallowed rather than retried forever, the
 * lookup can only ever match a GOOGLE_PLAY order, a malformed (attacker-shaped)
 * notification is never used to build a database filter, and a transient
 * failure (economy freeze, DB error) is audited and rethrown rather than
 * swallowed into a false "handled" response.
 */
describe('GoogleRtdnService', () => {
  const ORDER = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'user-1',
    status: PurchaseOrderStatus.COMPLETED,
    totalCoins: 250n,
    providerTxnRef: 'GPA.1',
  };

  const build = (order: any = ORDER) => {
    const reverseWallet = jest.fn().mockResolvedValue({ transactionId: 'tx-rev' });
    const updateOrderStatus = jest
      .fn()
      .mockResolvedValue({ ...order, status: PurchaseOrderStatus.REFUNDED });
    const prisma: any = {
      purchaseOrder: { findFirst: jest.fn().mockResolvedValue(order) },
      paymentReceipt: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const logAudit = jest.fn();
    const service = new GoogleRtdnService(
      prisma,
      { updateOrderStatus } as any,
      { reverseWallet } as any,
      { logAudit } as any,
    );
    return { service, reverseWallet, updateOrderStatus, prisma, logAudit };
  };

  const voided = {
    version: '1.0',
    packageName: 'com.soulzaa.app',
    eventTimeMillis: '1750000000000',
    voidedPurchaseNotification: {
      purchaseToken: 'tok-1',
      orderId: 'GPA.1',
      productType: 1,
      refundType: 1,
    },
  };

  it('reverses the coins for a completed order', async () => {
    const { service, reverseWallet, updateOrderStatus } = build();

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(true);
    expect(reverseWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        amount: 250,
        idempotencyKey: 'REVERSAL_GPA.1',
      }),
      undefined,
    );
    expect(updateOrderStatus).toHaveBeenCalledWith('order-1', PurchaseOrderStatus.REFUNDED);
  });

  it('does nothing for an order that was never completed', async () => {
    const { service, reverseWallet } = build({ ...ORDER, status: PurchaseOrderStatus.FAILED });

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown purchase token', async () => {
    const { service, reverseWallet, prisma } = build();
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);

    const result = await service.handleNotification(voided);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('ignores notification types it does not handle', async () => {
    const { service, reverseWallet } = build();

    const result = await service.handleNotification({
      version: '1.0',
      packageName: 'com.soulzaa.app',
      eventTimeMillis: '1750000000000',
      testNotification: { version: '1.0' },
    } as any);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('ignores a null notification body instead of throwing (which would turn an un-actionable body into a 500 and an infinite Pub/Sub retry)', async () => {
    const { service, reverseWallet, prisma } = build();

    const result = await service.handleNotification(null as any);

    expect(result.handled).toBe(false);
    expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  it('ignores a non-object notification body instead of throwing', async () => {
    const { service, reverseWallet } = build();

    const result = await service.handleNotification('not-an-object' as any);

    expect(result.handled).toBe(false);
    expect(reverseWallet).not.toHaveBeenCalled();
  });

  describe('malformed voidedPurchaseNotification (attacker-shaped payload)', () => {
    // `DeveloperNotification` is a TypeScript interface — erased at runtime, so
    // nothing stops a decoded push body from omitting these fields or sending
    // the wrong type. If either ever reached a Prisma `where` as `undefined`,
    // Prisma drops that key (no strictUndefinedChecks in this schema) and the
    // "unique" lookup becomes an unfiltered `findFirst` — i.e. an arbitrary
    // order. These tests prove the database is never even queried.
    it('ignores a missing orderId without querying the database', async () => {
      const { service, reverseWallet, prisma } = build();

      const result = await service.handleNotification({
        version: '1.0',
        packageName: 'com.soulzaa.app',
        eventTimeMillis: '1750000000000',
        voidedPurchaseNotification: { purchaseToken: 'tok-1' } as any,
      });

      expect(result.handled).toBe(false);
      expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
      expect(prisma.paymentReceipt.findFirst).not.toHaveBeenCalled();
      expect(reverseWallet).not.toHaveBeenCalled();
    });

    it('ignores a missing purchaseToken without querying the database', async () => {
      const { service, reverseWallet, prisma } = build();

      const result = await service.handleNotification({
        version: '1.0',
        packageName: 'com.soulzaa.app',
        eventTimeMillis: '1750000000000',
        voidedPurchaseNotification: { orderId: 'GPA.1' } as any,
      });

      expect(result.handled).toBe(false);
      expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
      expect(prisma.paymentReceipt.findFirst).not.toHaveBeenCalled();
      expect(reverseWallet).not.toHaveBeenCalled();
    });

    it('ignores a non-string orderId without querying the database', async () => {
      const { service, reverseWallet, prisma } = build();

      const result = await service.handleNotification({
        version: '1.0',
        packageName: 'com.soulzaa.app',
        eventTimeMillis: '1750000000000',
        voidedPurchaseNotification: { orderId: 12345, purchaseToken: 'tok-1' } as any,
      });

      expect(result.handled).toBe(false);
      expect(prisma.purchaseOrder.findFirst).not.toHaveBeenCalled();
      expect(reverseWallet).not.toHaveBeenCalled();
    });
  });

  it('scopes the order lookup to GOOGLE_PLAY, not just any provider with a matching orderId', async () => {
    const { service, prisma } = build();

    await service.handleNotification(voided);

    expect(prisma.purchaseOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: PaymentProvider.GOOGLE_PLAY, providerTxnRef: 'GPA.1' },
      }),
    );
  });

  it('scopes the receipt fallback lookup to GOOGLE_PLAY too', async () => {
    const { service, prisma } = build();
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    prisma.paymentReceipt.findFirst.mockResolvedValue({ purchaseOrder: ORDER });

    await service.handleNotification(voided);

    expect(prisma.paymentReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider: PaymentProvider.GOOGLE_PLAY, receiptData: 'tok-1' },
      }),
    );
  });

  it('derives an identical idempotencyKey across redelivery, and leaves the order in a consistent REFUNDED state both times', async () => {
    const { service, reverseWallet, updateOrderStatus } = build();

    const first = await service.handleNotification(voided);
    const second = await service.handleNotification(voided);

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(true);
    expect(reverseWallet).toHaveBeenCalledTimes(2);
    expect(reverseWallet.mock.calls[0][0].idempotencyKey).toBe('REVERSAL_GPA.1');
    expect(reverseWallet.mock.calls[1][0].idempotencyKey).toBe('REVERSAL_GPA.1');
    expect(updateOrderStatus).toHaveBeenNthCalledWith(1, 'order-1', PurchaseOrderStatus.REFUNDED);
    expect(updateOrderStatus).toHaveBeenNthCalledWith(2, 'order-1', PurchaseOrderStatus.REFUNDED);
  });

  it('refuses to reverse an amount that would lose precision above Number.MAX_SAFE_INTEGER, and audits before throwing', async () => {
    const hugeOrder = { ...ORDER, totalCoins: BigInt(Number.MAX_SAFE_INTEGER) + 1n };
    const { service, reverseWallet, updateOrderStatus, logAudit } = build(hugeOrder);

    await expect(service.handleNotification(voided)).rejects.toThrow(
      /exceeds Number.MAX_SAFE_INTEGER/,
    );

    expect(reverseWallet).not.toHaveBeenCalled();
    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      'order-1',
      'REFUND_REVERSAL_FAILED',
      expect.objectContaining({ orderId: 'GPA.1' }),
    );
  });

  it('does not swallow a transient reverseWallet failure (e.g. economy freeze) — it audits, then rethrows so Pub/Sub retries', async () => {
    const { service, reverseWallet, updateOrderStatus, logAudit } = build();
    reverseWallet.mockRejectedValue(new Error('economy frozen'));

    await expect(service.handleNotification(voided)).rejects.toThrow('economy frozen');

    expect(updateOrderStatus).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      'order-1',
      'REFUND_REVERSAL_FAILED',
      expect.objectContaining({ orderId: 'GPA.1', error: 'economy frozen' }),
    );
  });

  it('rethrows the ORIGINAL reversal failure even when the audit write for it also fails', async () => {
    // If `logAudit` itself throws inside the catch block, that must not replace
    // the real cause — the original error is what a retry needs to eventually
    // resolve, and losing it behind an unrelated audit-write failure would be
    // strictly worse than not auditing at all.
    const { service, reverseWallet, logAudit } = build();
    reverseWallet.mockRejectedValue(new Error('economy frozen'));
    logAudit.mockRejectedValue(new Error('audit db is also down'));

    await expect(service.handleNotification(voided)).rejects.toThrow('economy frozen');
  });
});
