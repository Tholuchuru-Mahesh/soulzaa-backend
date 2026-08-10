import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PaymentProvider, PurchaseOrderStatus } from '@prisma/client';
import { ReceiptVerificationService } from './receipt-verification.service';

/**
 * Every assertion here is a way a valid receipt could settle an order it has no
 * business settling. Each test asserts the wallet was NOT credited — a rejection
 * that still credits is the failure mode that matters.
 */
describe('ReceiptVerificationService guards', () => {
  const ORDER = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    userId: 'user-1',
    provider: PaymentProvider.GOOGLE_PLAY,
    status: PurchaseOrderStatus.CREATED,
    totalCoins: '250',
    priceAmount: 100,
    currency: 'INR',
    package: { id: 'pkg-1', googleProductId: 'in_gold_100' },
  };

  const GOOD_RESULT = {
    isVerified: true,
    providerTxnId: 'GPA.1',
    productId: 'in_gold_100',
    purchaseState: 0,
    consumptionState: 0,
    externalAccountId: 'user-1',
  };

  let creditWallet: jest.Mock;
  let consumeProductPurchase: jest.Mock;
  let verifyReceipt: jest.Mock;
  let logAudit: jest.Mock;
  let prismaMock: any;
  let service: ReceiptVerificationService;

  const build = (order: any = ORDER) => {
    creditWallet = jest.fn().mockResolvedValue({ transactionId: 'tx-1' });
    consumeProductPurchase = jest.fn().mockResolvedValue(undefined);
    verifyReceipt = jest.fn().mockResolvedValue(GOOD_RESULT);
    logAudit = jest.fn();

    const prisma: any = {
      paymentReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'rcpt-1' }),
        update: jest.fn().mockResolvedValue({ id: 'rcpt-1', isVerified: true }),
      },
      purchaseOrder: {
        update: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
    };
    prismaMock = prisma;
    const orderService: any = {
      getOrderById: jest.fn().mockResolvedValue(order),
      updateOrderStatus: jest.fn().mockResolvedValue({
        ...order,
        status: PurchaseOrderStatus.COMPLETED,
        completedAt: new Date(),
      }),
    };

    return new ReceiptVerificationService(
      prisma,
      orderService,
      { getAdapter: () => ({ verifyReceipt }) } as any,
      { creditWallet } as any,
      { isEconomyFrozen: jest.fn().mockResolvedValue(false) } as any,
      { validatePolicyLimit: jest.fn().mockResolvedValue(true) } as any,
      { logAudit } as any,
      { consumeProductPurchase } as any,
    );
  };

  const dto = { orderId: 'order-1', receiptData: 'tok-1' };

  it('credits and then consumes on a clean purchase', async () => {
    service = build();

    const result = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(result.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);
    expect(consumeProductPurchase).toHaveBeenCalledWith('in_gold_100', 'tok-1');
    // Consume must run after the credit, never before.
    expect(creditWallet.mock.invocationCallOrder[0]).toBeLessThan(
      consumeProductPurchase.mock.invocationCallOrder[0],
    );
  });

  it('rejects when the caller does not own the order', async () => {
    service = build();

    await expect(service.verifyAndFulfillPurchase(dto, 'attacker')).rejects.toThrow(
      ForbiddenException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects when the receipt is for a different product than the order', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, productId: 'in_gold_40000' });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('proceeds when Google returns no productId at all, and still consumes the order package SKU', async () => {
    // `ProductPurchase.productId` is documented as "may not be present". An
    // unconditional `verificationResult.productId !== expectedProductId` compares
    // undefined against 'in_gold_100' and rejects EVERY purchase the moment
    // Google omits it — a 100% failure rate, not an edge case. The pairing is
    // already enforced by GooglePlayApiClient interpolating the expected
    // productId into the request path, so an absent value is safe to proceed on.
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, productId: undefined });

    const result = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(result.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);
    // The consume must key off the ORDER's product, not the absent response
    // field — otherwise exactly these purchases skip the consume and strand the
    // SKU as owned-and-unconsumed in Play.
    expect(consumeProductPurchase).toHaveBeenCalledWith('in_gold_100', 'tok-1');
  });

  it('rejects a pending purchase', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, purchaseState: 2 });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects an already-consumed purchase', async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, consumptionState: 1 });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it("rejects a token bound to another user's account", async () => {
    service = build();
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, externalAccountId: 'someone-else' });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('still reports success when the consume call fails after a successful credit, and audits the failure', async () => {
    service = build();
    consumeProductPurchase.mockRejectedValue(new Error('network'));

    const result = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(result.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);
    // A swallowed consume failure must still leave a trace, or it is invisible in
    // production.
    expect(logAudit).toHaveBeenCalledWith(
      'order-1',
      'CONSUME_FAILED',
      { reason: 'network' },
      'user-1',
    );
    // consumedAt must stay null — it is the work queue the reconciliation sweep
    // reads. Stamping it on failure would hide the order from the only retry
    // that exists.
    expect(prismaMock.purchaseOrder.update).not.toHaveBeenCalled();
  });

  it('rejects a non-owner even when the order is already COMPLETED, without leaking order details', async () => {
    // Locks in that the ownership check runs BEFORE the already-completed
    // idempotent early return. If the order lookup happened first, an attacker
    // who knows a stranger's orderId could read back its orderNumber/totalCoins
    // simply by "re-verifying" it.
    const completedOrder = {
      ...ORDER,
      status: PurchaseOrderStatus.COMPLETED,
      totalCoins: '250',
      walletTransactionId: 'tx-existing',
    };
    service = build(completedOrder);

    let caught: any;
    try {
      await service.verifyAndFulfillPurchase(dto, 'attacker');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ForbiddenException);
    const body = JSON.stringify(caught.getResponse());
    expect(body).not.toContain(completedOrder.orderNumber);
    expect(body).not.toContain(completedOrder.totalCoins);
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects when the order package has no googleProductId configured', async () => {
    // A package with no googleProductId is not sellable on Android at all, so no
    // Play receipt can legitimately settle this order. Now that an absent
    // response productId is tolerated, the explicit `!expectedProductId` guard is
    // the ONLY thing catching this — deleting it must not leave this test green.
    const orderNoProductId = {
      ...ORDER,
      package: { id: 'pkg-1', googleProductId: null },
    };
    service = build(orderNoProductId);
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, productId: null });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('rejects when the order package has no googleProductId even if Google returns one', async () => {
    // The mismatch branch cannot catch this — there is nothing to mismatch
    // against. Without the `!expectedProductId` guard, a receipt for some other
    // SKU would settle an order for a package that was never listed on Android.
    service = build({ ...ORDER, package: { id: 'pkg-1', googleProductId: null } });
    verifyReceipt.mockResolvedValue({ ...GOOD_RESULT, productId: 'in_gold_100' });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('leaves the receipt unverified when the credit fails, so a retry is not blocked as a duplicate', async () => {
    // The money-loss path that does not self-heal. The receipt row is committed
    // before the credit and outside any shared transaction. If it were written
    // as `isVerified: true` and the credit then threw, every retry — including
    // the admin retry path — would 409 against the anti-replay check forever:
    // the user is charged, holds no coins, and the only recovery is Google's
    // 3-day auto-void.
    const receiptRows: any[] = [];
    const prisma: any = {
      paymentReceipt: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(receiptRows.find((r) => r.providerTxnId === where.providerTxnId) ?? null),
        ),
        create: jest.fn(({ data }: any) => {
          const row = { id: `rcpt-${receiptRows.length + 1}`, ...data };
          receiptRows.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn(({ where, data }: any) => {
          const row = receiptRows.find((r) => r.id === where.id);
          Object.assign(row, data);
          return Promise.resolve(row);
        }),
      },
      purchaseOrder: { update: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    };

    const creditWalletFailing = jest
      .fn()
      .mockRejectedValueOnce(new Error('economy freeze'))
      .mockResolvedValue({ transactionId: 'tx-1' });

    const orderService: any = {
      getOrderById: jest.fn().mockResolvedValue(ORDER),
      updateOrderStatus: jest.fn().mockResolvedValue({
        ...ORDER,
        status: PurchaseOrderStatus.COMPLETED,
        completedAt: new Date(),
      }),
    };

    service = new ReceiptVerificationService(
      prisma,
      orderService,
      { getAdapter: () => ({ verifyReceipt: jest.fn().mockResolvedValue(GOOD_RESULT) }) } as any,
      { creditWallet: creditWalletFailing } as any,
      { isEconomyFrozen: jest.fn().mockResolvedValue(false) } as any,
      { validatePolicyLimit: jest.fn().mockResolvedValue(true) } as any,
      { logAudit: jest.fn() } as any,
      { consumeProductPurchase: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow('economy freeze');

    // The leftover row must not claim verification it never earned.
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0].isVerified).toBe(false);

    // The retry must reach the credit again rather than 409 on anti-replay.
    const retry = await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(retry.isVerified).toBe(true);
    expect(creditWalletFailing).toHaveBeenCalledTimes(2);
    // Reused the existing row rather than colliding on the UNIQUE providerTxnId.
    expect(receiptRows).toHaveLength(1);
    expect(receiptRows[0].isVerified).toBe(true);
  });

  it('does not let a DIFFERENT order adopt an unverified leftover receipt', async () => {
    // The unverified-leftover path exists so the ORIGINAL order can retry. If
    // another order could adopt the token, the wallet idempotency key
    // `RECHARGE_${providerTxnId}` would hand back the first order's existing
    // transaction — no new coins move, yet the second order gets marked
    // COMPLETED against a purchase it never paid for.
    service = build();
    (service as any).prisma.paymentReceipt.findUnique.mockResolvedValue({
      id: 'rcpt-other',
      isVerified: false,
      purchaseOrderId: 'some-other-order',
    });

    await expect(service.verifyAndFulfillPurchase(dto, 'user-1')).rejects.toThrow(
      ConflictException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });

  it('stamps consumedAt on the order when the consume succeeds', async () => {
    service = build();

    await service.verifyAndFulfillPurchase(dto, 'user-1');

    expect(prismaMock.purchaseOrder.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: { consumedAt: expect.any(Date) },
    });
  });

  it('rejects a second order settled by the same verified purchase even when the client sends a different providerTxnId', async () => {
    // The client controls dto.providerTxnId, and that value doubles as both the
    // anti-replay lookup key and the wallet idempotency key. If the client's
    // value took priority over the adapter-verified one, a single real purchase
    // could settle two different orders by varying providerTxnId per call.
    const orderA = { ...ORDER, id: 'order-a', orderNumber: 'ORD-A' };
    const orderB = { ...ORDER, id: 'order-b', orderNumber: 'ORD-B' };

    creditWallet = jest.fn().mockResolvedValue({ transactionId: 'tx-1' });
    consumeProductPurchase = jest.fn().mockResolvedValue(undefined);
    // The adapter always verifies the SAME underlying purchase, regardless of
    // what providerTxnId the client claims in the DTO.
    verifyReceipt = jest.fn().mockResolvedValue(GOOD_RESULT);

    const receiptRows: any[] = [];
    const prisma: any = {
      paymentReceipt: {
        findUnique: jest.fn(({ where }: any) =>
          Promise.resolve(receiptRows.find((r) => r.providerTxnId === where.providerTxnId) ?? null),
        ),
        create: jest.fn((args: any) => {
          const row = { id: `rcpt-${receiptRows.length + 1}`, ...args.data };
          receiptRows.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn(({ where, data }: any) => {
          const row = receiptRows.find((r) => r.id === where.id);
          Object.assign(row, data);
          return Promise.resolve(row);
        }),
      },
      purchaseOrder: { update: jest.fn().mockResolvedValue({}) },
    };

    const orderService: any = {
      getOrderById: jest.fn((id: string) => Promise.resolve(id === 'order-a' ? orderA : orderB)),
      updateOrderStatus: jest.fn((id: string, status: PurchaseOrderStatus) =>
        Promise.resolve({
          ...(id === 'order-a' ? orderA : orderB),
          status,
          completedAt: new Date(),
        }),
      ),
    };

    service = new ReceiptVerificationService(
      prisma,
      orderService,
      { getAdapter: () => ({ verifyReceipt }) } as any,
      { creditWallet } as any,
      { isEconomyFrozen: jest.fn().mockResolvedValue(false) } as any,
      { validatePolicyLimit: jest.fn().mockResolvedValue(true) } as any,
      { logAudit: jest.fn() } as any,
      { consumeProductPurchase } as any,
    );

    const first = await service.verifyAndFulfillPurchase(
      { orderId: 'order-a', receiptData: 'tok-shared', providerTxnId: 'a' },
      'user-1',
    );
    expect(first.isVerified).toBe(true);
    expect(creditWallet).toHaveBeenCalledTimes(1);

    await expect(
      service.verifyAndFulfillPurchase(
        { orderId: 'order-b', receiptData: 'tok-shared', providerTxnId: 'b' },
        'user-1',
      ),
    ).rejects.toThrow(ConflictException);

    // The second order must not be credited just because the client attached a
    // fresh providerTxnId to the same underlying purchase.
    expect(creditWallet).toHaveBeenCalledTimes(1);
  });

  it("verifyAndFulfillPurchaseAsAdmin succeeds against another user's order and credits the order owner, not the admin", async () => {
    service = build();

    const result = await service.verifyAndFulfillPurchaseAsAdmin(dto, 'admin-1');

    expect(result.isVerified).toBe(true);
    // The buyer gets the coins, never the admin who retried verification.
    expect(creditWallet).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1' }),
      'admin-1',
    );
  });

  it('verifyAndFulfillPurchase (non-admin) still rejects that same cross-user case', async () => {
    service = build();

    await expect(service.verifyAndFulfillPurchase(dto, 'admin-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(creditWallet).not.toHaveBeenCalled();
  });
});
