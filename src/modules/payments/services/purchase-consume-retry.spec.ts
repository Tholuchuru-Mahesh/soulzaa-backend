import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { QUEUE_NAMES } from 'src/infra/queue/queue.constants';
import { PAYMENT_JOBS } from '../constants';
import { PurchaseReconciliationService } from './purchase-reconciliation.service';

/**
 * A failed consume strands the user permanently: the Flutter plugin's
 * `completePurchase` only ACKNOWLEDGES on Android, so the SKU stays
 * owned-and-unconsumed in Play. The user can never re-buy that tier, and
 * `restorePurchases()` redelivers the purchase on every launch into a
 * `PendingOrderStore.take()` that returns null — a permanent "could not be
 * matched to an order" error. This sweep is the only retry that exists.
 */
describe('PurchaseReconciliationService consume retry', () => {
  const order = (id: string, overrides: any = {}) => ({
    id,
    status: PurchaseOrderStatus.COMPLETED,
    provider: PaymentProvider.GOOGLE_PLAY,
    consumedAt: null,
    package: { googleProductId: 'in_gold_100' },
    receipts: [{ id: `rcpt-${id}`, isVerified: true, receiptData: `token-${id}` }],
    ...overrides,
  });

  let findMany: jest.Mock;
  let update: jest.Mock;
  let consumeProductPurchase: jest.Mock;
  let logAudit: jest.Mock;
  let register: jest.Mock;
  let service: PurchaseReconciliationService;

  const build = (orders: any[], isConfigured = true) => {
    findMany = jest.fn().mockResolvedValue(orders);
    update = jest.fn().mockResolvedValue({});
    consumeProductPurchase = jest.fn().mockResolvedValue(undefined);
    logAudit = jest.fn().mockResolvedValue({});
    register = jest.fn();

    const prisma: any = {
      purchaseOrder: { findMany, update, updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };

    service = new PurchaseReconciliationService(
      prisma,
      { isConfigured: () => isConfigured, consumeProductPurchase } as any,
      { logAudit } as any,
      { register } as any,
    );
    return service;
  };

  it('retries the consume for a COMPLETED order that was never consumed, and stamps consumedAt', async () => {
    build([order('order-1')]);

    const report = await service.retryPendingConsumes();

    expect(consumeProductPurchase).toHaveBeenCalledWith('in_gold_100', 'token-order-1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { consumedAt: expect.any(Date) },
    });
    expect(report).toMatchObject({ scanned: 1, consumed: 1, failed: 0, skipped: 0 });
  });

  it('queries only COMPLETED Google Play orders with a null consumedAt, bounded by the batch size', async () => {
    build([]);

    await service.retryPendingConsumes(25);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: PurchaseOrderStatus.COMPLETED,
          provider: PaymentProvider.GOOGLE_PLAY,
          consumedAt: null,
        },
        take: 25,
      }),
    );
  });

  it('does not stamp consumedAt when the consume fails', async () => {
    build([order('order-1')]);
    consumeProductPurchase.mockRejectedValue(new Error('503 backend error'));

    const report = await service.retryPendingConsumes();

    expect(update).not.toHaveBeenCalled();
    expect(report).toMatchObject({ scanned: 1, consumed: 0, failed: 1 });
    expect(logAudit).toHaveBeenCalledWith(
      'order-1',
      'CONSUME_RETRY_FAILED',
      expect.objectContaining({ reason: '503 backend error' }),
    );
  });

  it('one order failing does not abort the rest of the batch', async () => {
    build([order('order-1'), order('order-2'), order('order-3')]);
    consumeProductPurchase
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const report = await service.retryPendingConsumes();

    expect(consumeProductPurchase).toHaveBeenCalledTimes(3);
    expect(report).toMatchObject({ scanned: 3, consumed: 2, failed: 1 });
    expect(update.mock.calls.map((c) => c[0].where.id)).toEqual(['order-2', 'order-3']);
  });

  it('skips and logs an order with no usable purchase token instead of throwing', async () => {
    build([
      // No receipt at all.
      order('order-1', { receipts: [] }),
      // Receipt exists but was never verified — not a token we proved belongs here.
      order('order-2', { receipts: [{ id: 'r', isVerified: false, receiptData: 'tok' }] }),
      // Package is not listed on Android, so there is no SKU to consume.
      order('order-3', { package: { googleProductId: null } }),
    ]);

    const report = await service.retryPendingConsumes();

    expect(consumeProductPurchase).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(report).toMatchObject({ scanned: 3, consumed: 0, failed: 0, skipped: 3 });
  });

  it('does nothing when the Google Play API is not configured', async () => {
    build([order('order-1')], false);

    const report = await service.retryPendingConsumes();

    expect(findMany).not.toHaveBeenCalled();
    expect(report).toMatchObject({ scanned: 0, consumed: 0 });
  });

  it('registers the sweep handler on the same queue job the scheduler enqueues', async () => {
    build([]);

    service.onModuleInit();

    expect(register).toHaveBeenCalledWith(
      QUEUE_NAMES.WALLET_PROCESSING,
      PAYMENT_JOBS.RECONCILE_SWEEP,
      expect.any(Function),
    );
  });

  it('the sweep runs both the expiry pass and the consume retry', async () => {
    build([order('order-1')]);

    const result = await service.runReconciliationSweep();

    expect(result.expiredCount).toBe(0);
    expect(result.consumes).toMatchObject({ scanned: 1, consumed: 1 });
  });
});
