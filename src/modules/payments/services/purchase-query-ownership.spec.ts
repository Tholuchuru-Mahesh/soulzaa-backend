import { NotFoundException } from '@nestjs/common';
import { PurchaseQueryService } from './purchase-query.service';

/**
 * `GET /payments/orders/:id` took no caller identity, so any authenticated user
 * could read any order — amounts, package, provider reference and all. A foreign
 * order 404s rather than 403s so the endpoint does not confirm the ID exists.
 *
 * These tests assert on the `where` clause actually sent to Prisma, not just on
 * the returned/thrown value — the mock resolves independently of what the
 * implementation queries for, so asserting only on the outcome would still pass
 * even if `userId` were silently dropped from the query.
 */
describe('PurchaseQueryService order ownership', () => {
  const ORDER = {
    id: 'order-1',
    userId: 'owner',
    orderNumber: 'ORD-1',
    coinsAmount: 250n,
    bonusCoinsAmount: 0n,
    totalCoins: 250n,
    priceAmount: 100,
  };

  const build = (found: any) => {
    const findFirst = jest.fn().mockResolvedValue(found);
    const prisma: any = { purchaseOrder: { findFirst } };
    const service = new PurchaseQueryService(prisma);
    return { service, findFirst };
  };

  it('returns the order to its owner, scoping the query to that user', async () => {
    const { service, findFirst } = build(ORDER);

    const result = await service.getOrderDetails('order-1', 'owner');

    expect(result.id).toBe('order-1');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'owner',
          OR: [{ id: 'order-1' }, { orderNumber: 'order-1' }],
        }),
      }),
    );
  });

  it('404s for a user who does not own the order, having queried scoped to that caller', async () => {
    // The ownership filter is applied in the query, so a foreign order finds nothing.
    const { service, findFirst } = build(null);

    await expect(service.getOrderDetails('order-1', 'someone-else')).rejects.toThrow(
      NotFoundException,
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'someone-else',
          OR: [{ id: 'order-1' }, { orderNumber: 'order-1' }],
        }),
      }),
    );
  });
});
